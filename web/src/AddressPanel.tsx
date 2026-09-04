import { useMemo, type ReactNode } from 'react'
import { SearchField } from './MapShell'
import { searchAddressBook, type AddressEntry, type AddressKind } from './addressBook'

/**
 * The city's address book: one searchable list of everywhere you can go.
 *
 * Query families, tables and infrastructure facilities are three different kinds of thing, but they
 * are all destinations on the same map, so they share one search box. Splitting them into three
 * lists would mean knowing which list a thing lives in before you could find it. They stay grouped
 * under headings so the kinds remain legible, and each entry shows its address, which is the whole
 * point of the panel — it tells you where the thing physically is.
 */

const ICONS: Readonly<Record<AddressKind, string>> = {
  query: '◈',
  table: '▤',
  facility: '⌂',
}

export function AddressBook({
  entries,
  term,
  onTermChange,
  open,
  onOpenChange,
  selectedId,
  onSelect,
  footer,
}: {
  entries: readonly AddressEntry[]
  term: string
  onTermChange: (term: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedId: string | null
  onSelect: (entry: AddressEntry) => void
  footer?: ReactNode
}) {
  const groups = useMemo(() => searchAddressBook(entries, term), [entries, term])
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0)
  /*
   * Closed by default, and whichever rail region you open instead takes the room it gives up.
   *
   * This directory is the retained view -- the families, tables and facilities the collector has
   * accumulated -- and the feed above it is what is happening right now. Only one of those two
   * changes while you watch it, so the rail defaults to the one that does. Measured at 1115x800 the
   * feed sat on its 162px floor in every state with the directory open, showing two rows of a log
   * that was scrolling 47; closed, it has the rest of the column.
   *
   * `open` is a prop rather than the browser's own toggle because the directory is one of four
   * regions sharing one fixed-height column, and only one of the four may be open at a time -- see
   * `sidebarAccordion.ts`. Owning the state here would make that invariant unenforceable, since this
   * component cannot see the other three. A search term still pins it open, but that now happens in
   * the same reducer that closes the others, so pinning it open closes them too.
   */
  const hasTerm = term.trim().length > 0

  return (
    <>
      <details
        className="sidebar-directory"
        open={open}
        onToggle={event => {
          const next = (event.currentTarget as HTMLDetailsElement).open
          // A term is holding it open, so a close click has to clear the term as well or the element
          // would reopen on the next render and the click would look like it did nothing.
          if (!next && hasTerm) onTermChange('')
          onOpenChange(next)
        }}
      >
        <summary>
          City directory
          <span className="drawer-badge">
            {hasTerm ? `${total} of ${entries.length}` : `${entries.length}`} place{entries.length === 1 ? '' : 's'}
          </span>
        </summary>

        <div className="sidebar-search">
          <SearchField
            value={term}
            onChange={onTermChange}
            label="Search queries, tables and infrastructure"
            placeholder="Search queries, tables, infrastructure"
          />
        </div>

        <div className="sidebar-scroll">
          {total === 0 ? (
            <p className="address-empty">
              {entries.length === 0
                ? 'Nothing has been loaded for this database yet.'
                : `Nothing in this city matches “${term}”.`}
            </p>
          ) : (
            groups.map(group => (
              <section key={group.kind} className="address-group" aria-label={group.label}>
                <h2 className="address-group-heading">
                  {group.label}
                  <span>{group.entries.length}</span>
                </h2>
                <ul className="address-list">
                  {group.entries.map(entry => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        data-address-id={entry.id}
                        className={`address-entry ${entry.id === selectedId ? 'is-selected' : ''}`}
                        aria-pressed={entry.id === selectedId}
                        onClick={() => onSelect(entry)}
                      >
                        <span className={`address-icon is-${entry.kind}`} aria-hidden="true">{ICONS[entry.kind]}</span>
                        <span className="address-text">
                          <strong>{entry.name}</strong>
                          <span>{entry.meta}</span>
                          {/* An entry with no lot on the loaded page says so rather than inventing one. */}
                          <small>{entry.address ?? 'Not on the loaded page'}</small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </details>

      {footer}
    </>
  )
}
