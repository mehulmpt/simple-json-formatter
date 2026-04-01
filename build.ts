import { build, context, type BuildOptions } from 'esbuild'
import { cpSync, mkdirSync, rmSync, readdirSync } from 'fs'

const isWatch = process.argv.includes('--watch')

// Clean and recreate output directory
rmSync('out', { recursive: true, force: true })
mkdirSync('out', { recursive: true })

// Copy static assets that don't need compilation
cpSync('src/manifest.json', 'out/manifest.json')

// Copy icon PNGs into out/
for (const file of readdirSync('assets')) {
	const isIcon = file.startsWith('icon-') && file.endsWith('.png')
	if (isIcon) cpSync(`assets/${file}`, `out/${file}`)
}

const options: BuildOptions = {
	entryPoints: ['src/content.ts'],
	bundle: true,
	outdir: 'out',
	format: 'iife',
	target: 'chrome120',
	minify: !isWatch,
	loader: { '.css': 'text' },
}

if (isWatch) {
	const ctx = await context(options)
	await ctx.watch()
	console.log('Watching for changes...')
} else {
	await build(options)
	console.log('Build complete → out/')
}
