// Flat config. `next lint` was removed in Next 16, so the lint script calls eslint
// directly, which needs a config file of its own. eslint-config-next exports a
// ready-made flat config array.
import next from 'eslint-config-next'

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...next,
]

export default config
