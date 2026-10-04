import { describe, expect, it } from 'vitest'
import demoResponse from '../../../../../scripts/consumer/project-board.json'
import boardSchema from '../../../../../scripts/consumer/project-board.schema.json'
import { syntheticBoardResponse, toBoard } from './syntheticBoard'

type Schema = {
  type?: string; enum?: unknown[]; pattern?: string; anyOf?: Schema[]; items?: Schema
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; minimum?: number; maximum?: number
}

// Just the JSON Schema keywords the generated board schema uses; `format` is covered by `pattern`.
const violations = (value: unknown, schema: Schema, path = '$'): string[] => {
  if (schema.anyOf) return schema.anyOf.some(option => violations(value, option, path).length === 0) ? [] : [`${path}: no anyOf branch matches`]
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value
  if (schema.type && schema.type !== kind && !(schema.type === 'number' && kind === 'integer')) return [`${path}: ${kind} is not ${schema.type}`]
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: not one of ${schema.enum.join(', ')}`]
  if (schema.pattern && !new RegExp(schema.pattern).test(value as string)) return [`${path}: does not match ${schema.pattern}`]
  if (typeof value === 'number' && ((schema.minimum ?? -Infinity) > value || (schema.maximum ?? Infinity) < value)) return [`${path}: out of range`]
  if (Array.isArray(value) && schema.items) return value.flatMap((item, i) => violations(item, schema.items!, `${path}[${i}]`))
  if (kind !== 'object' || !schema.properties) return []
  const record = value as Record<string, unknown>
  return [
    ...(schema.required ?? []).filter(key => !(key in record)).map(key => `${path}.${key}: missing`),
    ...(schema.additionalProperties === false ? Object.keys(record).filter(key => !(key in schema.properties!)).map(key => `${path}.${key}: not allowed`) : []),
    ...Object.entries(schema.properties).flatMap(([key, child]) => key in record ? violations(record[key], child, `${path}.${key}`) : []),
  ]
}

describe('synthetic boards', () => {
  it('match the pinned InferOps board response schema, as the DEMO fixture does', () => {
    const schema = boardSchema.schema as Schema
    expect(violations(demoResponse, schema)).toEqual([])
    expect(violations({ ...demoResponse, projectId: 'not-a-uuid' }, schema)).not.toEqual([])
    expect(violations(syntheticBoardResponse({ issues: 500 }), schema)).toEqual([])
  })

  it('spread the requested issues over six columns, and keep only the card fields for the browser', () => {
    const response = syntheticBoardResponse({ issues: 500 })
    expect(response.columns.map(column => column.issues.length)).toEqual([84, 84, 83, 83, 83, 83])
    const board = toBoard(response)
    expect(board.project).toEqual(response.projects[0])
    expect(Object.keys(board.columns[0]!.issues[0]!)).not.toContain('lease')
    expect(board.columns.flatMap(column => column.issues)).toHaveLength(500)
    // Deterministic, so the recorded payload sizes are reproducible.
    expect(JSON.stringify(syntheticBoardResponse({ issues: 500 }))).toBe(JSON.stringify(response))
  })
})
