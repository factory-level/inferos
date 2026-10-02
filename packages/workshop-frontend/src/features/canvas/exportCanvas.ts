import { parseCanvasDefinition, type CanvasDefinition } from '@gadgets/workshop-shared/canvas'
import { saveTextToFile } from '../../fileTransfers'

export const exportCanvas = (definition: CanvasDefinition) => {
  // Revalidate at the export boundary: additional fields must never enter a portable definition.
  const portable = parseCanvasDefinition(definition)
  saveTextToFile(`canvas-${portable.id}.json`, JSON.stringify(portable, null, 2) + '\n')
}
