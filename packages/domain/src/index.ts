/**
 * @zona/domain — decide/evolve и порты канонического ядра (I01, `09_EVENT_AND_COMMAND_CONTRACTS`
 * §11). Границы пакета исполняются `pnpm boundaries:check`/`pnpm lint` (ADR-002, ADR-003), а не
 * соглашением: только `@zona/contracts`, ни часов, ни случайности, ни сети, ни файловой системы.
 */

export type { Clock } from './ports/clock.ts';
export { FixedClock } from './ports/clock.ts';

export type { RandomDraw, RandomSource } from './ports/random-source.ts';
export { DeterministicRandomSource } from './ports/random-source.ts';

export type { IdFactory } from './ports/id-factory.ts';
export { DerivedIdFactory, SequentialIdFactory } from './ports/id-factory.ts';

export type { CautionRange, Ruleset, RulesetVersions } from './ports/ruleset.ts';
export {
  FixedRuleset,
  PROTOTYPE_CAUTION_RANGE,
  PROTOTYPE_GOAL_WEIGHTS,
  PROTOTYPE_NEEDS,
  PROTOTYPE_REST_MINUTES,
  RULES_VERSION,
  rulesetFor,
  testRuleset,
  testRulesetVersions,
} from './ports/ruleset.ts';

export type { GoalDecision, GoalSituation, GoalWeights, RouteCost, TravelOption } from './goals.ts';
export {
  GOAL_SCORE_BOUNDS,
  MAX_GOAL_DURATION_MINUTES,
  chooseGoal,
  chooseRoute,
  requireValidGoalWeights,
} from './goals.ts';

export type { NeedConfig, NeedThresholdCrossing } from './needs.ts';
export {
  betterThan,
  isWorsening,
  needLevelAt,
  needLevelOf,
  needValueAt,
  nextThresholdCrossing,
  requireValidNeedConfig,
} from './needs.ts';

export type {
  AgentState,
  AgentDecideAction,
  AgentEatAction,
  AgentRestAction,
  AgentTravelAction,
  AgentStatus,
  ItemState,
  JourneyCompleteAction,
  LocationState,
  RestCompleteAction,
  NeedThresholdAction,
  RouteDefinition,
  RouteKnowledge,
  ScheduledAction,
  WorldState,
} from './state.ts';
export {
  SCHEDULED_ACTION_PRIORITY,
  agentDecideActionId,
  agentEatActionId,
  agentRestActionId,
  agentTravelActionId,
  isAgentFree,
  needThresholdActionId,
  planIdFor,
} from './state.ts';

export type { DecideContext, DecideRejection, DecideResult, DraftWorldEvent } from './decide.ts';
export { decide } from './decide.ts';

export { evolve } from './evolve.ts';
