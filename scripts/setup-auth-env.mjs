// Generates the signing keys Convex Auth needs and stores them, with SITE_URL, as environment variables of a deployment.
// Usage: node scripts/setup-auth-env.mjs            (dev deployment, SITE_URL=http://localhost:5173)
//        node scripts/setup-auth-env.mjs --prod     (production, SITE_URL=the GitHub Pages address)
// Running it again replaces the keys, which signs everybody out.
import { exportJWK, exportPKCS8, generateKeyPair } from 'jose'
import { execFileSync } from 'node:child_process'
const prod = process.argv.includes('--prod')
const keys = await generateKeyPair('RS256', { extractable: true })
const privateKey = (await exportPKCS8(keys.privateKey)).trimEnd().replace(/\n/g, ' ')
const jwks = JSON.stringify({ keys: [{ use: 'sig', ...(await exportJWK(keys.publicKey)) }] })
const set = (name, value) => execFileSync(process.execPath, ['node_modules/convex/bin/main.js', 'env', 'set', ...(prod ? ['--prod'] : []), name, '--', value], { stdio: ['ignore', 'ignore', 'inherit'] })
set('JWT_PRIVATE_KEY', privateKey)
set('JWKS', jwks)
set('SITE_URL', prod ? 'https://ivanblinov.github.io/figma-clone' : 'http://localhost:5173')
console.log('env set for', prod ? 'prod' : 'dev')
