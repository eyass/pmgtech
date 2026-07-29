/**
 * Grouping for the identity pickers on the admin screen.
 *
 * Pulled out of the component because the thing that went wrong here was not
 * rendering, it was visibility: leavers were present in the list but unfindable
 * under twenty current employees, and ignored engineers were dropped entirely, so a
 * third of the directory could not be picked and nothing on screen said so. That is
 * a rule about which people are offered and how they are announced, which is worth
 * testing directly rather than through a select element.
 */

export type EngineerOption = {
  id: string
  name: string
  /** Not currently employed. Their history is still inside the reporting window. */
  former?: boolean
  /** Excluded from every metric. Linking to one hides the work rather than moving it. */
  ignored?: boolean
}

export type EngineerOptionGroup = {
  label: string
  list: EngineerOption[]
}

/**
 * Groups in the order a picker should offer them, empty groups dropped.
 *
 * The count belongs in the label. A native select gives no hint that a second group
 * exists further down, so without it the first group reads as the whole list — which
 * is exactly how twenty current employees hid ten leavers.
 */
export function groupEngineerOptions(engineers: EngineerOption[]): EngineerOptionGroup[] {
  const current = engineers.filter((e) => !e.former && !e.ignored)
  const former = engineers.filter((e) => e.former && !e.ignored)
  const ignored = engineers.filter((e) => e.ignored)

  return [
    { label: `Currently employed (${current.length})`, list: current },
    { label: `Former or added by hand (${former.length})`, list: former },
    { label: `Ignored — linked work stays hidden (${ignored.length})`, list: ignored },
  ].filter((group) => group.list.length > 0)
}

/**
 * True when the groups carry no information — one group is a heading over the whole
 * list, so the picker should render a flat list instead of pointless chrome.
 */
export function shouldGroup(groups: EngineerOptionGroup[]): boolean {
  return groups.length > 1
}
