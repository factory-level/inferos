import { expect, it } from 'vitest'
import { snippetParts } from './wikiSearch'

it('reads only InferOps\' <b> markers, keeping every other character as text', () => {
  expect(snippetParts('The <b>release</b> <i>steps</i> &lt;b&gt;')).toEqual([
    { text: 'The ', highlight: false }, { text: 'release', highlight: true }, { text: ' <i>steps</i> &lt;b&gt;', highlight: false },
  ])
  // A cut inside a highlight leaves it open to the end; a stray closing marker is dropped.
  expect(snippetParts('Freeze the <b>rele')).toEqual([{ text: 'Freeze the ', highlight: false }, { text: 'rele', highlight: true }])
  expect(snippetParts('ase</b> branch')).toEqual([{ text: 'ase', highlight: false }, { text: ' branch', highlight: false }])
  expect(snippetParts('')).toEqual([])
})
