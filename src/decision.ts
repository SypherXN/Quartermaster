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

/** Rendezvous score: lower wins, and the chance a provider wins is pace / total pace. */
export function weightedProviderScore(seed: string, providerID: string, pace: number | undefined): number {
  if (typeof pace !== "number" || !Number.isFinite(pace) || pace <= 0) return Number.POSITIVE_INFINITY
  return -Math.log(providerDraw(seed, providerID)) / pace
}

/**
 * Weighted provider allocation for one request. Providers race once each, with
 * a weight equal to their sustainable pace, so over many independent seeds the
 * first provider picked appears in proportion to that pace -- true weighted
 * rendezvous, not a sort that would always name the same winner. Unknown,
 * zero, negative and non-finite weights always rank last; ties fall to
 * `pick.path`, then to the file's order, and models on the winning provider keep
 * the order the category declares.
 */
export function orderCategoryByWeightedPace(
  category: CategoryDef,
  pace: QuotaPace,
  seed: string,
): readonly ModelRef[] {
  if (category.pick?.by !== "weighted-pace") return category.models
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
      score: weightedProviderScore(seed, providerID, pace(group.members[0])),
    }))
    .sort((left, right) => {
      if (left.score !== right.score) return left.score < right.score ? -1 : 1
      const byPath = (path.get(left.providerID) ?? far) - (path.get(right.providerID) ?? far)
      return byPath !== 0 ? byPath : left.index - right.index
    })
    .flatMap((entry) => entry.members)
}
