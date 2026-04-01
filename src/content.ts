/**
 * Simple JSON Formatter — Chrome Extension Content Script
 *
 * Detects JSON documents (application/json, text/json, text/plain) and replaces
 * the raw text with a syntax-highlighted, collapsible tree view.
 *
 * Permission minimisation:
 *  - No "permissions" declared in manifest — only content_scripts with <all_urls>.
 *  - CSS is NOT loaded via manifest (would inject on every page). Instead it is
 *    bundled into this script and injected only when a JSON document is detected.
 *  - Runs at document_start for fast detection before the browser paints.
 *
 * Performance:
 *  - Uses textContent (not innerHTML) to avoid HTML parser overhead and XSS.
 *  - Builds the entire DOM tree inside a DocumentFragment (single reflow).
 *  - Event delegation — one click handler on the container instead of per-node.
 *  - Auto-collapses nodes deeper than MAX_OPEN_DEPTH.
 *
 * State machine:
 *  - Detection flows through explicit states: ContentTypeKind → PreDetectionResult
 *    → ParseResult. Every branch is handled — no silent fall-throughs.
 *  - Click delegation classifies every target as toggle / copy-icon / unrelated.
 *  - Toggle nodes track collapsed/expanded as an explicit boolean.
 */

import styles from './styles.css'

// ── Types ───────────────────────────────────────────────────────────────

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject
interface JsonObject {
	[key: string]: JsonValue
}

interface ToggleState {
	isCollapsed: boolean
	inner: HTMLDivElement
	ellipsis: HTMLSpanElement
	count: HTMLSpanElement
}

/** Result of classifying the document's content-type header. */
type ContentTypeKind = 'json' | 'text' | 'unsupported'

/** Result of looking for a valid <pre> element in the DOM. */
type PreDetectionResult =
	| { isFound: true; pre: HTMLPreElement }
	| { isFound: false; reason: 'no-body' | 'no-pre' | 'multiple-pre' | 'has-text-elements' | 'is-hidden' | 'is-empty' }

/** Result of attempting to parse raw text as JSON. */
type ParseResult =
	| { isValid: true; value: JsonValue }
	| { isValid: false; reason: 'parse-error' | 'is-scalar' }

/** Classification of a click target inside the JSON container. */
type ClickTarget =
	| { kind: 'toggle'; element: HTMLSpanElement; state: ToggleState }
	| { kind: 'copy-icon'; element: HTMLSpanElement; value: JsonValue }
	| { kind: 'unrelated' }

// ── Exhaustive check ────────────────────────────────────────────────────

/**
 * Compile-time exhaustiveness guard. If a switch is missing a case, TypeScript
 * will error because the unhandled variant is not assignable to `never`.
 * At runtime this throws — it should be unreachable in correct code.
 */
function exhaustiveGuard(value: never): never {
	throw new Error(`Unhandled discriminant: ${JSON.stringify(value)}`)
}

// ── Entry point ─────────────────────────────────────────────────────────

/**
 * Self-invoking wrapper. Since we run at document_start, the body may not
 * exist yet. We wait for DOMContentLoaded before inspecting the page.
 */
;(() => {
	const isRawMode = window.location.hash === '#raw'
	if (isRawMode) return

	const onReady = () => {
		document.removeEventListener('DOMContentLoaded', onReady)
		detectAndFormat()
	}

	const isStillLoading = document.readyState === 'loading'
	if (isStillLoading) {
		document.addEventListener('DOMContentLoaded', onReady)
	} else {
		detectAndFormat()
	}
})()

// ── Detection ───────────────────────────────────────────────────────────

/**
 * Runs the full detection pipeline and, if the page is a JSON document,
 * replaces it with the formatted view.
 *
 * Pipeline: ContentTypeKind → PreDetectionResult → ParseResult → render
 */
function detectAndFormat(): void {
	// Step 1 — content type classification
	const contentTypeKind = classifyContentType(document.contentType || '')
	switch (contentTypeKind) {
		case 'json':
		case 'text':
			break // continue detection
		case 'unsupported':
			return
		default:
			exhaustiveGuard(contentTypeKind)
	}

	// Step 2 — DOM structure validation
	const preResult = detectPre()
	if (!preResult.isFound) return

	// Step 3 — JSON parse
	const parseResult = tryParseJson(preResult.pre.textContent || '')
	if (!parseResult.isValid) return

	render(parseResult.value, preResult.pre.textContent || '')
}

/** Classifies the MIME type into one of three buckets. */
function classifyContentType(contentType: string): ContentTypeKind {
	const isJsonMime = /^application\/(json|[\w.+-]*\+json)/.test(contentType)
	if (isJsonMime) return 'json'

	const isTextMime = contentType === 'text/plain' || contentType === 'text/json'
	if (isTextMime) return 'text'

	return 'unsupported'
}

/**
 * Validates that the page looks like a browser-rendered raw text response:
 * a single visible <pre> with no surrounding text elements.
 */
function detectPre(): PreDetectionResult {
	const body = document.body
	if (!body) return { isFound: false, reason: 'no-body' }

	const pres = body.querySelectorAll('pre')
	if (pres.length === 0) return { isFound: false, reason: 'no-pre' }
	if (pres.length > 1) return { isFound: false, reason: 'multiple-pre' }

	// Reject pages that contain textual HTML elements (not a raw response)
	const hasTextElements =
		body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, ul, ol, table').length > 0
	if (hasTextElements) return { isFound: false, reason: 'has-text-elements' }

	const pre = pres[0]

	const isHidden =
		pre.offsetParent === null && getComputedStyle(pre).display === 'none'
	if (isHidden) return { isFound: false, reason: 'is-hidden' }

	const isEmpty = !pre.textContent || !pre.textContent.trim()
	if (isEmpty) return { isFound: false, reason: 'is-empty' }

	return { isFound: true, pre }
}

/**
 * Attempts to parse raw text as JSON.
 * Only objects and arrays are accepted — scalars are not useful as tree views.
 */
function tryParseJson(raw: string): ParseResult {
	let value: JsonValue
	try {
		value = JSON.parse(raw) as JsonValue
	} catch {
		return { isValid: false, reason: 'parse-error' }
	}

	const isScalar = typeof value !== 'object' || value === null
	if (isScalar) return { isValid: false, reason: 'is-scalar' }

	return { isValid: true, value }
}

// ── Rendering ───────────────────────────────────────────────────────────

/** Nodes nested deeper than this are rendered collapsed by default. */
const MAX_OPEN_DEPTH = 4

/** Maps a toggle element to its collapsible state. */
const toggleMap = new Map<HTMLSpanElement, ToggleState>()

/** Maps a copy-icon element to the raw JSON value it should copy. */
const copyValueMap = new Map<HTMLSpanElement, JsonValue>()

/**
 * Replaces the page contents with the formatted JSON view.
 * Injects CSS only at this point — non-JSON pages never load our styles.
 */
function render(parsed: JsonValue, rawText: string): void {
	const fragment = document.createDocumentFragment()

	// Inject CSS (only on JSON pages)
	const style = document.createElement('style')
	style.textContent = styles
	fragment.appendChild(style)

	// Toolbar
	const toolbar = document.createElement('div')
	toolbar.className = 'sjf-toolbar'

	const title = document.createElement('span')
	title.className = 'sjf-title'
	title.textContent = 'JSON'

	const rawLink = document.createElement('a')
	rawLink.className = 'sjf-btn'
	rawLink.textContent = 'Raw'
	rawLink.href = window.location.href.split('#')[0] + '#raw'
	rawLink.addEventListener('click', (e: MouseEvent) => {
		e.preventDefault()
		window.location.hash = '#raw'
		window.location.reload()
	})

	const copyBtn = document.createElement('button')
	copyBtn.className = 'sjf-btn'
	copyBtn.textContent = 'Copy'
	copyBtn.addEventListener('click', () => {
		navigator.clipboard.writeText(JSON.stringify(parsed, null, 2))
		copyBtn.textContent = 'Copied!'
		setTimeout(() => {
			copyBtn.textContent = 'Copy'
		}, 1500)
	})

	const size = document.createElement('span')
	size.className = 'sjf-size'
	size.textContent = formatBytes(rawText.length)

	toolbar.append(title, size, rawLink, copyBtn)

	// JSON tree
	const container = document.createElement('div')
	container.className = 'sjf-container'
	container.appendChild(renderValue(parsed, 0))
	container.addEventListener('click', handleContainerClick)

	fragment.append(toolbar, container)

	document.body.innerHTML = ''
	document.body.classList.add('sjf-body')
	document.body.appendChild(fragment)
}

// ── Event delegation ────────────────────────────────────────────────────

/** Classifies what was clicked inside the container. */
function classifyClickTarget(target: HTMLSpanElement): ClickTarget {
	const hasToggleState = toggleMap.has(target)
	if (hasToggleState) {
		return { kind: 'toggle', element: target, state: toggleMap.get(target)! }
	}

	const hasCopyValue = copyValueMap.has(target)
	if (hasCopyValue) {
		return { kind: 'copy-icon', element: target, value: copyValueMap.get(target)! }
	}

	return { kind: 'unrelated' }
}

/** Single click handler for all interactive elements inside the container. */
function handleContainerClick(e: MouseEvent): void {
	const classified = classifyClickTarget(e.target as HTMLSpanElement)

	switch (classified.kind) {
		case 'toggle': {
			const { element, state } = classified
			const wasCollapsed = state.isCollapsed

			state.isCollapsed = !wasCollapsed
			state.inner.style.display = wasCollapsed ? '' : 'none'
			state.ellipsis.style.display = wasCollapsed ? 'none' : ''
			state.count.style.display = wasCollapsed ? 'none' : ''
			element.textContent = wasCollapsed ? '\u25BE' : '\u25B8'
			return
		}

		case 'copy-icon': {
			e.stopPropagation()
			const { element, value } = classified
			const isString = typeof value === 'string'
			const text = isString ? value : JSON.stringify(value, null, 2)
			navigator.clipboard.writeText(text)
			element.textContent = '\u2713'
			element.classList.add('sjf-copy-icon-done')
			setTimeout(() => {
				element.textContent = '\u2398'
				element.classList.remove('sjf-copy-icon-done')
			}, 1200)
			return
		}

		case 'unrelated':
			return

		default:
			exhaustiveGuard(classified)
	}
}

// ── Tree renderers ──────────────────────────────────────────────────────

/**
 * Renders any JSON value into a DOM node.
 * Exhaustively handles every JSON value type.
 */
function renderValue(value: JsonValue, depth: number): HTMLSpanElement {
	if (value === null) return makeSpan('null', 'sjf-null')

	switch (typeof value) {
		case 'string':
			return renderString(value)
		case 'number':
			return makeSpan(String(value), 'sjf-number')
		case 'boolean':
			return makeSpan(String(value), 'sjf-boolean')
		case 'object': {
			const isArray = Array.isArray(value)
			return isArray
				? renderArray(value, depth)
				: renderObject(value, depth)
		}
		default:
			exhaustiveGuard(value)
	}
}

/**
 * Renders a string value. URLs become clickable <a> links.
 */
function renderString(value: string): HTMLSpanElement {
	const wrapper = document.createElement('span')
	wrapper.className = 'sjf-string'

	const isUrl = /^https?:\/\//.test(value) || value.startsWith('//')
	if (isUrl) {
		wrapper.appendChild(document.createTextNode('"'))
		const link = document.createElement('a')
		link.className = 'sjf-link'
		link.href = value
		link.textContent = value
		link.target = '_blank'
		link.rel = 'noopener noreferrer'
		wrapper.appendChild(link)
		wrapper.appendChild(document.createTextNode('"'))
	} else {
		wrapper.textContent = `"${value}"`
	}

	return wrapper
}

/** Renders a JSON object as a collapsible `{ ... }` block. */
function renderObject(obj: JsonObject, depth: number): HTMLSpanElement {
	const keys = Object.keys(obj)
	const isEmpty = keys.length === 0
	if (isEmpty) return makeSpan('{}', 'sjf-bracket')

	const isInitiallyCollapsed = depth >= MAX_OPEN_DEPTH
	const wrapper = document.createElement('span')
	const toggle = makeToggle(isInitiallyCollapsed)
	const open = makeSpan('{', 'sjf-bracket')
	const close = makeSpan('}', 'sjf-bracket')

	const ellipsis = makeSpan('...', 'sjf-ellipsis')
	ellipsis.style.display = isInitiallyCollapsed ? '' : 'none'

	const count = makeSpan(
		`// ${keys.length} ${keys.length === 1 ? 'key' : 'keys'}`,
		'sjf-count'
	)
	count.style.display = isInitiallyCollapsed ? '' : 'none'

	const inner = document.createElement('div')
	inner.className = 'sjf-indent'
	if (isInitiallyCollapsed) inner.style.display = 'none'

	const isLastKey = (i: number) => i === keys.length - 1
	keys.forEach((key, i) => {
		const line = document.createElement('div')
		line.className = 'sjf-line'
		line.append(
			makeCopyIcon(obj[key]),
			makeSpan(`"${key}"`, 'sjf-key'),
			makeSpan(': ', 'sjf-colon'),
			renderValue(obj[key], depth + 1)
		)
		if (!isLastKey(i)) line.appendChild(makeSpan(',', 'sjf-comma'))
		inner.appendChild(line)
	})

	toggleMap.set(toggle, {
		isCollapsed: isInitiallyCollapsed,
		inner,
		ellipsis,
		count
	})
	wrapper.append(toggle, open, ellipsis, count, inner, close)
	return wrapper
}

/** Renders a JSON array as a collapsible `[ ... ]` block. */
function renderArray(arr: JsonValue[], depth: number): HTMLSpanElement {
	const isEmpty = arr.length === 0
	if (isEmpty) return makeSpan('[]', 'sjf-bracket')

	const isInitiallyCollapsed = depth >= MAX_OPEN_DEPTH
	const wrapper = document.createElement('span')
	const toggle = makeToggle(isInitiallyCollapsed)
	const open = makeSpan('[', 'sjf-bracket')
	const close = makeSpan(']', 'sjf-bracket')

	const ellipsis = makeSpan('...', 'sjf-ellipsis')
	ellipsis.style.display = isInitiallyCollapsed ? '' : 'none'

	const count = makeSpan(
		`// ${arr.length} ${arr.length === 1 ? 'item' : 'items'}`,
		'sjf-count'
	)
	count.style.display = isInitiallyCollapsed ? '' : 'none'

	const inner = document.createElement('div')
	inner.className = 'sjf-indent'
	if (isInitiallyCollapsed) inner.style.display = 'none'

	const isLastItem = (i: number) => i === arr.length - 1
	arr.forEach((val, i) => {
		const line = document.createElement('div')
		line.className = 'sjf-line'
		line.append(makeCopyIcon(val), renderValue(val, depth + 1))
		if (!isLastItem(i)) line.appendChild(makeSpan(',', 'sjf-comma'))
		inner.appendChild(line)
	})

	toggleMap.set(toggle, {
		isCollapsed: isInitiallyCollapsed,
		inner,
		ellipsis,
		count
	})
	wrapper.append(toggle, open, ellipsis, count, inner, close)
	return wrapper
}

// ── DOM helpers ─────────────────────────────────────────────────────────

/** Creates a <span> with textContent (safe, no HTML parsing). */
function makeSpan(text: string, className: string): HTMLSpanElement {
	const span = document.createElement('span')
	span.className = className
	span.textContent = text
	return span
}

/** Creates a toggle arrow (▾ expanded / ▸ collapsed). */
function makeToggle(isCollapsed: boolean): HTMLSpanElement {
	const btn = document.createElement('span')
	btn.className = 'sjf-toggle'
	btn.textContent = isCollapsed ? '\u25B8' : '\u25BE'
	return btn
}

/** Creates a copy icon, registered in copyValueMap for delegation. */
function makeCopyIcon(value: JsonValue): HTMLSpanElement {
	const btn = document.createElement('span')
	btn.className = 'sjf-copy-icon'
	btn.textContent = '\u2398'
	btn.title = 'Copy value'
	copyValueMap.set(btn, value)
	return btn
}

/** Formats a byte count into a human-readable string. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
