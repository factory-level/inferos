import { expect, it } from 'vitest'
import { snippetParts } from './wikiSnippet'

it('reads only InferOps\' paired <b> markers, keeping every other character as text', () => {
  expect(snippetParts('The <b>release</b> <i>steps</i> &lt;b&gt;')).toEqual([
    { text: 'The ', highlight: false }, { text: 'release', highlight: true }, { text: ' <i>steps</i> &lt;b&gt;', highlight: false },
  ])
  expect(snippetParts('')).toEqual([])
})

it('keeps an unmatched marker as the literal text it is', () => {
  // A cut inside a highlight leaves its opening marker unmatched: shown as written, not highlighted.
  expect(snippetParts('Freeze the <b>rele')).toEqual([{ text: 'Freeze the <b>rele', highlight: false }])
  // A lone closing marker, cut or the author's own, stays literal (QA, inferos#336).
  expect(snippetParts('ase</b> branch')).toEqual([{ text: 'ase</b> branch', highlight: false }])
  expect(snippetParts('<b>tag</b></b> again')).toEqual([{ text: 'tag', highlight: true }, { text: '</b> again', highlight: false }])
  // An opening marker followed by another opening marker pairs only the second.
  expect(snippetParts('<b>one <b>two</b>')).toEqual([{ text: '<b>one ', highlight: false }, { text: 'two', highlight: true }])
  expect(snippetParts('<b></b>')).toEqual([])
})
