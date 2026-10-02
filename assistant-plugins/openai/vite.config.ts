import { vitestTask } from '@gadgets/scripts/vitest-task'

export default {
  run: { tasks: {
    build: { command: 'tsc' },
    test: vitestTask('bun test src'),
  } },
}
