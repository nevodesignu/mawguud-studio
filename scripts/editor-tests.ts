// Editor store test battery: group/ungroup mechanics.
// Run: npm run editor-tests
;(globalThis as { fetch?: unknown }).fetch = async () => ({ ok: true, json: async () => ({}) })

import { useStudio } from '../src/store/studio'

const s = () => useStudio.getState()
let failures = 0
const check = (cond: boolean, what: string) => {
  if (!cond) {
    failures++
    console.log('FAIL', what)
  } else console.log('ok  ', what)
}

const ids = () => s().design.elements.map((e) => e.id)

// three texts on the default blank design
s().addText()
s().addText()
const [a, b, c] = ids()

// group a+b
s().selectMany([a, b])
s().groupSelected()
const el = (id: string) => s().design.elements.find((e) => e.id === id)!
check(!!el(a).groupId && el(a).groupId === el(b).groupId, 'group assigns one shared groupId')
check(el(c).groupId === undefined, 'outsider not grouped')

// clicking one member selects the whole group
s().select(null)
s().select(a)
check(s().selectedIds.length === 2 && s().selectedIds.includes(b), 'clicking a member selects the group')

// additive click on an outside element adds it; additive click on a member removes the whole group
s().select(c, true)
check(s().selectedIds.length === 3, 'shift-click adds outsider to group selection')
s().select(b, true)
check(s().selectedIds.length === 1 && s().selectedIds[0] === c, 'shift-click on member toggles whole group off')

// marquee catching one member pulls the whole group
s().selectMany([a])
check(s().selectedIds.length === 2, 'marquee expansion pulls whole group')

// group moves as one (and marks placed)
const ax = el(a).x
const bx = el(b).x
s().moveSelected(15, 0)
check(el(a).x === ax + 15 && el(b).x === bx + 15, 'group drags as one unit')

// duplicate the group: copies form their OWN group
s().duplicateSelected()
const dupIds = s().selectedIds
check(dupIds.length === 2, 'duplicating a group copies both members')
const dupGid = el(dupIds[0]).groupId
check(!!dupGid && dupGid === el(dupIds[1]).groupId && dupGid !== el(a).groupId, 'duplicated group is its own group')

// copy/paste: same rule
s().selectMany([a])
s().copySelected()
s().paste()
const pasteIds = s().selectedIds
check(pasteIds.length === 2, 'pasting a group pastes both members')
check(el(pasteIds[0]).groupId !== el(a).groupId, 'pasted group is its own group')

// ungroup
s().selectMany([a])
s().ungroupSelected()
check(el(a).groupId === undefined && el(b).groupId === undefined, 'ungroup clears the group')
s().select(null)
s().select(a)
check(s().selectedIds.length === 1, 'after ungroup, clicking selects just the one element')

// --- board-centering moves the selection as ONE unit (the old behavior
// slammed every member onto the center line, piling groups up) ---
s().select(null)
s().updateEl(a, { x: 60, y: 40 })
s().updateEl(b, { x: 140, y: 90 })
s().addDivider()
const dv = ids()[ids().length - 1]
s().updateEl(dv, { x: 100, y: 65 })
s().selectMany([a, b, dv])
s().alignSelected('board-h')
s().alignSelected('board-v')
check(Math.abs(el(a).x - el(b).x - (60 - 140)) < 0.11, 'centering keeps the horizontal arrangement')
check(Math.abs(el(a).y - el(b).y - (40 - 90)) < 0.11, 'centering keeps the vertical arrangement')
check(Math.abs(el(a).x - el(dv).x - (60 - 100)) < 0.11 && Math.abs(el(a).y - el(dv).y - (40 - 65)) < 0.11, 'divider rides with the unit')
check(Math.abs(el(a).x - el(b).x) > 10, 'members not piled onto one line')
// Same X / Same Y still collapse to a shared axis - that is their job
s().selectMany([a, b])
s().alignSelected('match-x')
check(Math.abs(el(a).x - el(b).x) < 0.11, 'Same X still unifies the axis')

console.log(failures === 0 ? '\nGROUPING: ALL GREEN' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
