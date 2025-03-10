import { Address, BigInt, BigDecimal, log } from "@graphprotocol/graph-ts";
import { ethereum } from "@graphprotocol/graph-ts";
import { Rewarder } from "../../../../../generated/MasterChefV2/Rewarder";
import { TokenABI as ERC20 } from "../../../../../generated/templates/Pair/TokenABI";
import {
  _MasterChefAddressToPid,
  _MasterChefRewarder,
  _MasterChefStakingPool,
  _RewarderProbe,
  LiquidityPool,
  _MasterChef,
} from "../../../../../generated/schema";
import {
  BIGDECIMAL_ZERO,
  BIGINT_ZERO,
  ZERO_ADDRESS,
} from "../../../../../src/common/constants";
import {
  getRewardsPerDay,
  RewardIntervalType,
} from "../../../../../src/common/rewards";
import { NetworkConfigs } from "../../../../../configurations/configure";
import {
  convertTokenToDecimal,
  roundToWholeNumber,
} from "../../../../../src/common/utils/utils";
import {
  getOrCreateRewardToken,
  getOrCreateToken,
} from "../../../../../src/common/getters";
import { RewarderCalculator } from "./rewarderRate/rewardRateCalculator";

class BonusAmounts {
  amount: BigInt;
  amountUSD: BigDecimal;
}

class RewardObj {
  tokenId: string;
  amount: BigInt;
  amountUSD: BigDecimal;
}

export class PoolRewardData {
  tokens: string[];
  amounts: Array<BigInt>;
  amountsUSD: Array<BigDecimal>;
}

// setPoolRewarder will set, remove or replace a given rewarder
// when a masterchef staking pool is added or updated. It will not update
// pool reward tokens, since that will happen on every deposit/withdrawal from the pool.
export function setPoolRewarder(
  addr: Address,
  pool: _MasterChefStakingPool
): void {
  if (addr.toHexString() == ZERO_ADDRESS) {
    removeRewarder(pool);
    return;
  }

  replaceRewarder(addr, pool);
}

// replaceRewarder will remove the current rewarder of a staking pool and add a new one.
// Token emissions will be updated on the next deposit/withdrawal after the replacement.
function replaceRewarder(addr: Address, pool: _MasterChefStakingPool): void {
  removeRewarder(pool);
  addRewarder(addr, pool);
}

// removeRewarder will remove the rewarder assigned to some staking pool (if any).
// Token emissions will be updated on the next deposit/withdrawal after the replacement.
function removeRewarder(sPool: _MasterChefStakingPool): void {
  sPool.rewarder = null;
}

// addRewarder adds a rewarder to a given staking pool and updates the pool
// reward token and emission values.
function addRewarder(addr: Address, sPool: _MasterChefStakingPool): void {
  let rewarder = getOrCreateRewarder(addr, sPool);
  sPool.rewarder = rewarder.id;
}

// getPoolRewardsWithBonus will be called on every masterchef deposit or withdrawal
// to update bonus rewards if a rewarder exists for that pool.
export function getPoolRewardsWithBonus(
  event: ethereum.Event,
  mc: _MasterChef,
  sPool: _MasterChefStakingPool,
  liqPool: LiquidityPool,
  user: Address,
  isDeposit: boolean = false
): PoolRewardData | null {
  if (!sPool.rewarder) {
    return null;
  }

  let rewarderAddr = Address.fromString(sPool.rewarder!);
  let rewarder = getOrCreateRewarder(rewarderAddr, sPool);

  let calc = new RewarderCalculator(mc, rewarder);
  calc.calculateRewarderRate(event, user, isDeposit);

  return buildRewards(
    event,
    liqPool,
    rewarder,
    rewarderHasFunds(event, rewarder)
  );
}

// rewarderHasFunds will return true if it finds the rewarder has a balance > 0 for the
// token given as reward. If the last check was too recent, it will return the stored value instead.
// If it is unable to fetch the balance, it will assume
// the rewarder DOES have balance.
function rewarderHasFunds(
  event: ethereum.Event,
  rewarder: _MasterChefRewarder
): boolean {
  // only check rewarder balance once per day
  const ONE_DAY = BigInt.fromI32(24 * 3600);
  if (event.block.timestamp.minus(rewarder.hasFundsAt).lt(ONE_DAY)) {
    return rewarder.hasFunds;
  }

  let bal = fetchRewarderBalance(rewarder);
  if (!bal) {
    log.error("unable to fetch rewarder balance: {}", [rewarder.id]);
    return true;
  }

  rewarder.hasFunds = true;
  if (bal.equals(BIGINT_ZERO)) {
    rewarder.hasFunds = false;
  }

  rewarder.hasFundsAt = event.block.timestamp;
  rewarder.save();
  return rewarder.hasFunds;
}

function buildRewards(
  event: ethereum.Event,
  pool: LiquidityPool,
  rewarder: _MasterChefRewarder,
  rewarderHasFunds: boolean
): PoolRewardData {
  let rewardToken = getOrCreateRewardToken(NetworkConfigs.getRewardToken());
  let bonusToken = getOrCreateRewardToken(rewarder.rewardToken);

  let bonus = calculateBonusRewardAmounts(event, rewarder, rewarderHasFunds);

  let rewards: RewardObj[] = [];
  rewards.push({
    tokenId: rewardToken.id,
    amount: pool.rewardTokenEmissionsAmount![0], // position 0 because it is the only token at the moment.
    amountUSD: pool.rewardTokenEmissionsUSD![0], // idem
  });
  rewards.push({
    tokenId: bonusToken.id,
    amount: bonus.amount,
    amountUSD: bonus.amountUSD,
  });

  rewards.sort((a: RewardObj, b: RewardObj): i32 => {
    if (a.tokenId < b.tokenId) {
      return -1;
    }
    return 1;
  }); // need to sort for the order to match with rewardAmounts when querying. -> https://discord.com/channels/953684103012683796/953685205531631637/974188732154544178

  let pr: PoolRewardData = <PoolRewardData>{
    tokens: [],
    amounts: [],
    amountsUSD: [],
  };
  for (let i = 0; i < rewards.length; i++) {
    pr.tokens.push(rewards[i].tokenId);
    pr.amounts.push(rewards[i].amount);
    pr.amountsUSD.push(rewards[i].amountUSD);
  }
  return pr;
}

// calculateBonusRewardAmounts will calculate the daily token and USD bonus emissions
// given by a rewarder.
function calculateBonusRewardAmounts(
  event: ethereum.Event,
  rewarder: _MasterChefRewarder,
  rewarderHasFunds: boolean
): BonusAmounts {
  if (!rewarderHasFunds) {
    return <BonusAmounts>{
      amount: BIGINT_ZERO,
      amountUSD: BIGDECIMAL_ZERO,
    };
  }

  let bonusRewards = getRewardsPerDay(
    event.block.timestamp,
    event.block.number,
    BigDecimal.fromString(rewarder.tokenPerSec.toString()),
    RewardIntervalType.TIMESTAMP
  );

  let bonusToken = getOrCreateToken(rewarder.rewardToken);

  let bonusAmount = BigInt.fromString(
    roundToWholeNumber(bonusRewards).toString()
  );
  let bonusAmountUSD = convertTokenToDecimal(
    bonusAmount,
    bonusToken.decimals
  ).times(bonusToken.lastPriceUSD!);

  return <BonusAmounts>{
    amount: bonusAmount,
    amountUSD: bonusAmountUSD,
  };
}

function getOrCreateRewarder(
  addr: Address,
  pool: _MasterChefStakingPool | null
): _MasterChefRewarder {
  let rewarder = _MasterChefRewarder.load(addr.toHexString());
  if (!rewarder) {
    if (!pool) {
      log.critical(
        "attempting to handle OnReward without registered rewarder: {}",
        [addr.toHexString()]
      );
    }

    let c = Rewarder.bind(addr);
    let token = getOrCreateRewardToken(c.rewardToken().toHexString());

    rewarder = new _MasterChefRewarder(addr.toHexString());
    rewarder.pool = pool!.id;
    rewarder.rewardToken = token.token;
    rewarder.canRetrieveRate = false;
    rewarder.hasFunds = true;
    rewarder.hasFundsAt = BIGINT_ZERO;
    rewarder.tokenPerSec = BIGINT_ZERO;
    rewarder.rateCalculatedAt = BIGINT_ZERO;

    let tokenPerSec = RewarderCalculator.attemptToRetrieveRewardRate(c);
    if (tokenPerSec) {
      rewarder.canRetrieveRate = true;
      rewarder.tokenPerSec = tokenPerSec;
    }

    let balance = fetchRewarderBalance(rewarder);
    if (balance && balance.equals(BIGINT_ZERO)) {
      rewarder.hasFunds = false;
    }

    rewarder.save();
  }
  return rewarder;
}

function fetchRewarderBalance(rewarder: _MasterChefRewarder): BigInt | null {
  let rewarderAddr = Address.fromString(rewarder.id);
  let c = Rewarder.bind(rewarderAddr);
  let tokenCall = c.try_rewardToken();
  if (tokenCall.reverted) {
    return null;
  }

  let token = ERC20.bind(tokenCall.value);
  let call = token.try_balanceOf(rewarderAddr);
  if (call.reverted) {
    return null;
  }
  return call.value;
}
