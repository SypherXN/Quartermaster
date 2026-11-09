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
  if (category.pick?.by !== "pace") return category.models
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
