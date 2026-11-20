import { createHash } from "node:crypto"
import type { CategoryDef, ModelRef, PlanOrder } from "./config.ts"

/** The provider window that decides urgency for one model. */
export interface QuotaClock {
  /** When that window resets, in epoch milliseconds. */
  resetsAt?: number
  /** Used share of that window, 0-100. */
  usedPercent?: number
}

export type QuotaLookup = (model: Pick<ModelRef, "providerID" | "modelID">) => QuotaClock | undefined

/**
 * A category's members in preference order.
 *
 * The window that resets first wins, because quota that resets is quota that
 * expires; using it now is the only way to spend it. Equal resets prefer the
 * window with more used, so a nearly-spent bucket empties before a fresh one.
 * `pick.path` then breaks provider ties, and the file's order breaks the rest.
 *
 * `pick.by: "in-order"` (or no pick at all) returns the file's order untouched,
 * which is what keeps two models on one provider in the sequence you wrote.
 */
export function orderCategory(category: CategoryDef, clock: QuotaLookup): readonly ModelRef[] {
  if (category.pick?.by !== "reset-soonest") return category.models
  const path = new Map((category.pick.path ?? []).map((provider, index) => [provider, index]))
  const far = Number.MAX_SAFE_INTEGER
  return category.models
    .map((model) => ({ model, quota: clock(model) }))
    .sort((left, right) => {
      const leftReset = left.quota?.resetsAt
      const rightReset = right.quota?.resetsAt
      if (leftReset !== rightReset) {
        if (leftReset === undefined) return 1
        if (rightReset === undefined) return -1
        return leftReset - rightReset
      }
      const used = (right.quota?.usedPercent ?? -1) - (left.quota?.usedPercent ?? -1)
      if (used !== 0) return used
      return (path.get(left.model.providerID) ?? far) - (path.get(right.model.providerID) ?? far)
    })
    .map(({ model }) => model)
}

/** A PlanOrder backed by whatever quota the caller can see right now. */
export function categoryOrder(clock: QuotaLookup): PlanOrder {
  return (category) => orderCategory(category, clock)
}

/** How fast a provider's tightest window lets this model spend: percent per minute. */
export type QuotaPace = (model: Pick<ModelRef, "providerID" | "modelID">) => number | undefined

/**
 * A category's members by how much room each provider can sustain.
 *
 * A request is charged to every window at once, so the window with the least
 * room per remaining minute is the one that decides how hard a provider can be
 * used. That figure already answers "how much of the weekly is left for each
 * remaining 5-hour block": a rate is the budget per block divided by the block's
 * length. The provider that can absorb the most per minute goes first; a
 * provider with no fresh clock sorts last; ties fall to `pick.path`, then to the
 * file's order.
 */
export function orderCategoryByPace(category: CategoryDef, pace: QuotaPace): readonly ModelRef[] {
  return orderByPace(category, pace, "pace")
}

/** `window-protection`: the same pace ranking, already scaled by its factor. */
export function orderCategoryByProtectedPace(category: CategoryDef, pace: QuotaPace): readonly ModelRef[] {
  return orderByPace(category, pace, "window-protection")
}

function orderByPace(category: CategoryDef, pace: QuotaPace, strategy: "pace" | "window-protection"): readonly ModelRef[] {
  if (category.pick?.by !== strategy) return category.models
  const path = new Map((category.pick.path ?? []).map((provider, index) => [provider, index]))
  const far = Number.MAX_SAFE_INTEGER
  return category.models
    .map((model) => ({ model, pace: pace(model) }))
    .sort((left, right) => {
      if (left.pace !== right.pace) {
        if (left.pace === undefined) return 1
        if (right.pace === undefined) return -1
        return right.pace - left.pace
      }
      return (path.get(left.model.providerID) ?? far) - (path.get(right.model.providerID) ?? far)
    })
    .map(({ model }) => model)
}

/** A PlanOrder that ranks a category by sustainable pace. */
export function paceCategoryOrder(pace: QuotaPace): PlanOrder {
  return (category) => orderCategoryByPace(category, pace)
}

/**
 * One provider's uniform draw from [0,1) for a seed. SHA-256 keeps it stable
 * across processes, so a restarted router repeats the same assignment instead
 * of keeping a scheduler or RNG. Only the provider ID is hashed: a second model
 * on that provider must not add a second chance to win.
 */
export function providerDraw(seed: string, providerID: string): number {
  const digest = createHash("sha256").update(seed).update("\0").update(providerID).digest()
  const draw = digest.readUIntBE(0, 6) / 2 ** 48
  // A zero draw (probability 2^-48) would make the race infinite; nudge it into
  // the open interval at the same scale as the smallest non-zero draw.
  return draw === 0 ? 2 ** -48 : draw
}

/**
 * Rendezvous score: lower wins, and the chance a provider wins is weight / total
 * weight. Weight here is the softened headroom (the square root of the remaining
 * percentage points), boosted while the provider is behind its monthly reserve
 * line, not the raw percentage.
 */
export function weightedProviderScore(seed: string, providerID: string, weight: number | undefined): number {
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) return Number.POSITIVE_INFINITY
  return -Math.log(providerDraw(seed, providerID)) / weight
}

/**
 * Weighted provider allocation for one request. Providers race once each, with
 * a weight equal to their remaining headroom -- the percentage points left in
 * their tightest window -- softened with a square root, so over many independent
 * seeds the first provider picked appears in proportion to that softened
 * headroom, closer to an even split than raw headroom would give. A provider
 * behind its monthly reserve line (50% spent with a week to go, ramping to 100%
 * at the reset) gets `1 + monthlyDeficit / 25` times that weight. Window length
 * is not part of the weight: a per-minute rate would let a freshly reset 5-hour
 * block outbid a monthly allowance by roughly a hundredfold. True weighted
 * rendezvous, not a sort that would always name the same winner. Unknown, zero,
 * negative and non-finite weights always rank last; ties fall to `pick.path`,
 * then to the file's order, and models on the winning provider keep the order
 * the category declares.
 */
export function orderCategoryByWeightedPace(
  category: CategoryDef,
  weight: (model: Pick<ModelRef, "providerID" | "modelID">) => number | undefined,
  seed: string,
): readonly ModelRef[] {
  return orderCategoryByProviderWeight(category, "weighted-pace", (model) => weight(model), seed)
}

/** Each step down the list keeps half the weight of the one above it. */
const PRIORITY_STEP = 0.5

/**
 * A model's `weighted-priority` weight before headroom is applied: its `pick.weights`
 * number when the category sets them (an unlisted model keeps 1), otherwise half
 * the weight of the entry above it, so the first model races twice as hard as
 * the second and four times as hard as the third.
 */
export function priorityWeight(category: CategoryDef, model: Pick<ModelRef, "providerID" | "modelID">): number {
  const weights = category.pick?.weights
  const key = `${model.providerID}/${model.modelID}`
  if (weights !== undefined) return Object.hasOwn(weights, key) ? weights[key]! : 1
  const index = category.models.findIndex((entry) => entry.providerID === model.providerID && entry.modelID === model.modelID)
  return PRIORITY_STEP ** Math.max(0, index)
}

/**
 * `weighted-priority`: the same weighted race, with the headroom draw weight
 * (softened, and boosted by any monthly deficit) multiplied by the model's place
 * in the category. Usage still moves the pick -- a preferred provider whose
 * headroom is nearly gone loses -- but a later entry needs a clearly larger
 * headroom to overtake the ones written above it.
 */
export function orderCategoryByWeightedPriority(
  category: CategoryDef,
  weight: (model: Pick<ModelRef, "providerID" | "modelID">) => number | undefined,
  seed: string,
): readonly ModelRef[] {
  return orderCategoryByProviderWeight(
    category,
    "weighted-priority",
    (model) => {
      const room = weight(model)
      return room === undefined ? undefined : room * priorityWeight(category, model)
    },
    seed,
  )
}

function orderCategoryByProviderWeight(
  category: CategoryDef,
  by: "weighted-pace" | "weighted-priority",
  weight: (model: ModelRef) => number | undefined,
  seed: string,
): readonly ModelRef[] {
  if (category.pick?.by !== by) return category.models
  const path = new Map((category.pick.path ?? []).map((provider, index) => [provider, index]))
  const far = Number.MAX_SAFE_INTEGER
  const groups = new Map<string, { members: ModelRef[]; index: number }>()
  for (const model of category.models) {
    const group = groups.get(model.providerID)
    if (group) group.members.push(model)
    else groups.set(model.providerID, { members: [model], index: groups.size })
  }
  return [...groups]
    .map(([providerID, group]) => ({
      providerID,
      members: group.members,
      index: group.index,
      // One provider races once, on its strongest member: a provider carrying a
      // preferred model must not be penalised by the one written below it.
      score: weightedProviderScore(seed, providerID, strongest(group.members.map(weight))),
    }))
    .sort((left, right) => {
      if (left.score !== right.score) return left.score < right.score ? -1 : 1
      const byPath = (path.get(left.providerID) ?? far) - (path.get(right.providerID) ?? far)
      return byPath !== 0 ? byPath : left.index - right.index
    })
    .flatMap((entry) => entry.members)
}

function strongest(weights: readonly (number | undefined)[]): number | undefined {
  let best: number | undefined
  for (const weight of weights) {
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) continue
    if (best === undefined || weight > best) best = weight
  }
  return best
}
