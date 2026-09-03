import { isIP } from 'node:net'
import { Parser } from 'htmlparser2'
import juice from 'juice'
import postcss, { type AtRule, type ChildNode, type Declaration, type Root, type Rule } from 'postcss'
import selectorParser from 'postcss-selector-parser'
import valueParser from 'postcss-value-parser'
import sanitizeHtml from 'sanitize-html'
import { SaxesParser } from 'saxes'
import { isTrackingImage } from '../src/email-images.ts'

const SAFE_DATA_IMAGE = /^data:image\/(?:avif|bmp|gif|jpe?g|png|webp);base64,[a-z\d+/=\s]+$/i
const MAX_EMAIL_STYLE_INPUT_BYTES = 256 * 1024
const MAX_EMAIL_STYLE_OUTPUT_BYTES = 128 * 1024
const MAX_EMAIL_STYLE_RULES = 512
const CSS_LENGTH = '(?:0|(?:\\d+|\\d*\\.\\d+)(?:px|em|rem|%|pt|pc|in|cm|mm|ch|ex))'
const CSS_MEDIA_LENGTH = '(?:0|(?:\\d+|\\d*\\.\\d+)(?:px|em|rem|pt|pc|in|cm|mm|ch|ex))'
const CSS_SIGNED_LENGTH = '(?:0|-?(?:\\d+|\\d*\\.\\d+)(?:px|em|rem|%|pt|pc|in|cm|mm|ch|ex))'
const CSS_ALPHA = '(?:0|1|0?\\.\\d+|\\d{1,3}%)'
const CSS_COLOR = `(?:#[a-f\\d]{3,4}|#[a-f\\d]{6}|#[a-f\\d]{8}|[a-z]{1,24}|rgba?\\(\\s*(?:\\d{1,3}%?\\s*,\\s*\\d{1,3}%?\\s*,\\s*\\d{1,3}%?(?:\\s*,\\s*${CSS_ALPHA})?|\\d{1,3}%?\\s+\\d{1,3}%?\\s+\\d{1,3}%?(?:\\s*\\/\\s*${CSS_ALPHA})?)\\s*\\)|hsla?\\(\\s*\\d{1,3}(?:\\s*,\\s*\\d{1,3}%\\s*,\\s*\\d{1,3}%(?:\\s*,\\s*${CSS_ALPHA})?|\\s+\\d{1,3}%\\s+\\d{1,3}%(?:\\s*\\/\\s*${CSS_ALPHA})?)\\s*\\))`
const CSS_BORDER_STYLE = '(?:none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)'
// Trailing spaces belong to the comma separator, not the name; overlapping
// whitespace here makes a failed font list require exponential backtracking.
const CSS_FONT_NAME = "(?:-?[a-z\\d][a-z\\d_-]*(?: +[a-z\\d_-]+)*|\"[a-z\\d][a-z\\d _-]*\"|'[a-z\\d][a-z\\d _-]*')"

const cssPattern = (value: string) => new RegExp(`^${value}$`, 'i')
const cssList = (value: string, count = 4) => cssPattern(`${value}(?:\\s+${value}){0,${count - 1}}`)
const length = cssPattern(CSS_LENGTH)
const color = cssPattern(CSS_COLOR)
const spacing = cssList(CSS_LENGTH)
const margin = cssList(`(?:${CSS_LENGTH}|auto)`)
const border = cssList(`(?:${CSS_LENGTH}|thin|medium|thick|${CSS_BORDER_STYLE}|${CSS_COLOR})`, 3)

const SAFE_EMAIL_STYLES: Record<string, RegExp[]> = {
  color: [color],
  background: [color],
  'background-color': [color],
  'font-size': [cssPattern(`(?:${CSS_LENGTH}|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)`)],
  'font-family': [cssPattern(`${CSS_FONT_NAME}(?:\\s*,\\s*${CSS_FONT_NAME})*`)],
  'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]\d{0,2}|1000)$/i],
  'font-style': [/^(?:normal|italic|oblique)$/i],
  'line-height': [cssPattern(`(?:normal|\\d+(?:\\.\\d+)?|${CSS_LENGTH})`)],
  'letter-spacing': [cssPattern(`(?:normal|${CSS_SIGNED_LENGTH})`)],
  'text-align': [/^(?:left|right|center|justify|start|end)$/i],
  'text-decoration': [cssList('(?:none|underline|overline|line-through|solid|double|dotted|dashed|wavy)')],
  'text-transform': [/^(?:none|capitalize|uppercase|lowercase|full-width|full-size-kana)$/i],
  'white-space': [/^(?:normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/i],
  'word-break': [/^(?:normal|break-all|keep-all|break-word)$/i],
  display: [/^(?:block|inline|inline-block|flex|inline-flex|table|inline-table|table-row|table-row-group|table-header-group|table-footer-group|table-cell|table-caption|list-item|none)$/i],
  visibility: [/^(?:visible|hidden|collapse)$/i],
  overflow: [/^(?:visible|hidden|clip|scroll|auto)$/i],
  'box-sizing': [/^(?:content-box|border-box)$/i],
  'table-layout': [/^(?:auto|fixed)$/i],
  'align-items': [/^(?:normal|stretch|center|start|end|flex-start|flex-end|baseline)$/i],
  'justify-content': [/^(?:normal|stretch|center|start|end|flex-start|flex-end|space-between|space-around|space-evenly)$/i],
  'flex-direction': [/^(?:row|row-reverse|column|column-reverse)$/i],
  'flex-wrap': [/^(?:nowrap|wrap|wrap-reverse)$/i],
  gap: [cssList(`(?:${CSS_LENGTH}|normal)`, 2)],
  'row-gap': [cssPattern(`(?:${CSS_LENGTH}|normal)`)],
  'column-gap': [cssPattern(`(?:${CSS_LENGTH}|normal)`)],
  float: [/^(?:none|left|right|inline-start|inline-end)$/i],
  opacity: [/^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/],
  width: [cssPattern(`(?:${CSS_LENGTH}|auto|min-content|max-content|fit-content)`)],
  'min-width': [cssPattern(`(?:${CSS_LENGTH}|auto|min-content|max-content|fit-content)`)],
  'max-width': [cssPattern(`(?:${CSS_LENGTH}|none|min-content|max-content|fit-content)`)],
  height: [cssPattern(`(?:${CSS_LENGTH}|auto|min-content|max-content|fit-content)`)],
  'min-height': [cssPattern(`(?:${CSS_LENGTH}|auto|min-content|max-content|fit-content)`)],
  'max-height': [cssPattern(`(?:${CSS_LENGTH}|none|min-content|max-content|fit-content)`)],
  padding: [spacing],
  'padding-top': [length],
  'padding-right': [length],
  'padding-bottom': [length],
  'padding-left': [length],
  'padding-block': [cssList(CSS_LENGTH, 2)],
  'padding-block-start': [length],
  'padding-block-end': [length],
  'padding-inline': [cssList(CSS_LENGTH, 2)],
  'padding-inline-start': [length],
  'padding-inline-end': [length],
  margin: [margin],
  'margin-top': [cssPattern(`(?:${CSS_LENGTH}|auto)`)],
  'margin-right': [cssPattern(`(?:${CSS_LENGTH}|auto)`)],
  'margin-bottom': [cssPattern(`(?:${CSS_LENGTH}|auto)`)],
  'margin-left': [cssPattern(`(?:${CSS_LENGTH}|auto)`)],
  'margin-block': [cssList(`(?:${CSS_LENGTH}|auto)`, 2)],
  'margin-block-start': [cssPattern(`(?:${CSS_LENGTH}|auto)`)],
  'margin-block-end': [cssPattern(`(?:${CSS_LENGTH}|auto)`)],
  'margin-inline': [cssList(`(?:${CSS_LENGTH}|auto)`, 2)],
  'margin-inline-start': [cssPattern(`(?:${CSS_LENGTH}|auto)`)],
  'margin-inline-end': [cssPattern(`(?:${CSS_LENGTH}|auto)`)],
  border: [border],
  'border-top': [border],
  'border-right': [border],
  'border-bottom': [border],
  'border-left': [border],
  'border-width': [cssList(`(?:${CSS_LENGTH}|thin|medium|thick)`)],
  'border-style': [cssList(CSS_BORDER_STYLE)],
  'border-color': [cssList(CSS_COLOR)],
  'border-radius': [cssPattern(`${CSS_LENGTH}(?:\\s+${CSS_LENGTH}){0,3}(?:\\s*\\/\\s*${CSS_LENGTH}(?:\\s+${CSS_LENGTH}){0,3})?`)],
  'border-top-left-radius': [cssList(CSS_LENGTH, 2)],
  'border-top-right-radius': [cssList(CSS_LENGTH, 2)],
  'border-bottom-left-radius': [cssList(CSS_LENGTH, 2)],
  'border-bottom-right-radius': [cssList(CSS_LENGTH, 2)],
  'border-collapse': [/^(?:collapse|separate)$/i],
  'border-spacing': [cssList(CSS_LENGTH, 2)],
  'vertical-align': [cssPattern(`(?:baseline|sub|super|text-top|text-bottom|middle|top|bottom|${CSS_LENGTH})`)],
  'object-fit': [/^(?:fill|contain|cover|none|scale-down)$/i],
}

const SAFE_EMAIL_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'img', 'figure', 'figcaption', 'font', 'picture', 's', 'source', 'strike',
]
const BACKGROUND_PROPERTIES = new Set([
  'background', 'background-image', 'background-size', 'background-repeat',
  'background-position', 'background-position-x', 'background-position-y',
])
const HTML_BACKGROUND_TAGS = new Set(['body', 'table', 'td', 'th'])
const BACKGROUND_POSITION = cssPattern(`(?:left|right|top|bottom|center|${CSS_SIGNED_LENGTH})`)
const BACKGROUND_SIZE = cssPattern(`(?:auto|cover|contain|${CSS_LENGTH})`)
const BACKGROUND_REPEAT = /^(?:repeat|repeat-x|repeat-y|no-repeat|space|round)$/i
type ImageSignals = Omit<Parameters<typeof isTrackingImage>[0], 'src'>
type EmailStyleContext = {
  remoteImages?: boolean
  remoteImage?: (source: string) => string
  contentIds?: ReadonlyMap<string, string>
  trackingBackgrounds?: ReadonlySet<string>
  onTrackingBackground?: (source: string) => void
  onBackgroundContent?: () => void
}

function emailStyleSignals(nodes: readonly ChildNode[], attributes: Record<string, string> = {}): ImageSignals {
  const style: Record<string, string> = {}
  const important = new Set<string>()
  for (const node of nodes) {
    if (node.type !== 'decl') continue
    const property = node.prop.toLowerCase()
    if (!['width', 'height', 'display', 'visibility', 'opacity'].includes(property) || (important.has(property) && !node.important)) continue
    style[property] = node.value.trim().toLowerCase()
    if (node.important) important.add(property)
  }
  return { width: attributes.width, height: attributes.height, style }
}

function resolveBackgroundImage(source: string, contentIds?: ReadonlyMap<string, string>): string {
  if (source.length > 1_024 || /[\\\u0000-\u001f\u007f<>]/.test(source)) return ''
  source = source.trim()
  const cid = source.match(/^cid:(.+)$/i)?.[1]
  if (cid) {
    let decoded = cid
    try { decoded = decodeURIComponent(cid) } catch { /* Match malformed escapes literally. */ }
    const target = contentIds?.get(cid) ?? contentIds?.get(decoded)
    return target && /^\/v1\/blobs\/[a-z\d_-]+$/i.test(target) ? target : ''
  }
  if (SAFE_DATA_IMAGE.test(source)) return source.replace(/\s/g, '')
  if (!/^https?:\/\//i.test(source)) return ''
  try {
    const url = new URL(source)
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
    // Only DNS-host HTTP(S) URLs: no credentials, IP literals, or local-only host names.
    if (url.username || url.password || isIP(host) || !host.includes('.') || /\.(?:localhost|local|internal)$/i.test(host)) return ''
    return url.href
  } catch { return '' }
}

function filterBackgroundImage(source: string, context: EmailStyleContext, signals: ImageSignals): string {
  if (!source) return ''
  let trackingSource = source
  try { trackingSource = decodeURIComponent(source) } catch { /* Malformed escapes cannot hide the original URL. */ }
  if (isTrackingImage({ src: trackingSource, ...signals }) || context.trackingBackgrounds?.has(source)) {
    context.onTrackingBackground?.(source)
    return ''
  }
  context.onBackgroundContent?.()
  if (!/^https?:/i.test(source)) return source
  return context.remoteImages === true ? context.remoteImage?.(source) ?? source : ''
}

function sanitizeBackgroundValue(property: string, value: string, context: EmailStyleContext, signals: ImageSignals): string {
  if (!value || value.length > 1_024) return ''
  const parsed = valueParser(value)
  let invalid = false
  let count = 0
  parsed.walk(node => {
    if (++count > 128 || node.type === 'comment' || ('unclosed' in node && node.unclosed)) invalid = true
  })
  if (invalid) return ''
  const nodes = parsed.nodes.filter(node => node.type !== 'space')
  if (nodes.length === 1 && nodes[0]?.type === 'word' && /^(?:inherit|initial|unset|revert)$/i.test(nodes[0].value)) return nodes[0].value
  const layers: valueParser.Node[][] = [[]]
  for (const node of nodes) {
    if (node.type === 'div' && node.value === ',') layers.push([])
    else layers.at(-1)!.push(node)
  }
  if (layers.length > 8 || layers.some(layer => !layer.length)) return ''
  const output: string[][] = []
  const images: Array<{ source: string; layer: string[]; index: number }> = []
  for (const layer of layers) {
    const tokens: string[] = []
    let imageCount = 0
    let slash = false
    for (const node of layer) {
      if (node.type === 'function' && node.value.toLowerCase() === 'url' && ['background', 'background-image'].includes(property)) {
        if (++imageCount > 1) return ''
        // Reparse uppercase URL() through the parser's URL-token grammar too.
        const normalized = valueParser(`url(${valueParser.stringify(node.nodes)})`).nodes
        const urlNode = normalized.length === 1 && normalized[0]?.type === 'function' ? normalized[0] : undefined
        const argument = urlNode?.nodes.length === 1 ? urlNode.nodes[0] : undefined
        const source = urlNode && !urlNode.unclosed && argument && (argument.type === 'string' || argument.type === 'word')
          && !('unclosed' in argument && argument.unclosed)
          && (argument.type === 'string' || !/[\s()"']/.test(argument.value))
          ? resolveBackgroundImage(argument.value, context.contentIds) : ''
        images.push({ source, layer: tokens, index: tokens.length })
        tokens.push('none')
      } else if (node.type === 'div' && node.value === '/' && property === 'background' && !slash && tokens.length && node !== layer.at(-1)) {
        slash = true
        tokens.push('/')
      } else {
        const token = valueParser.stringify(node)
        const word = node.type === 'word'
        const permitted = property === 'background-image' ? word && /^none$/i.test(token)
          : property === 'background-size' ? word && BACKGROUND_SIZE.test(token)
          : property === 'background-repeat' ? word && BACKGROUND_REPEAT.test(token)
          : property.startsWith('background-position') ? word && BACKGROUND_POSITION.test(token)
          : property === 'background' && (
            (word && (BACKGROUND_POSITION.test(token) || BACKGROUND_SIZE.test(token) || BACKGROUND_REPEAT.test(token)
              || /^(?:none|scroll|fixed|local|border-box|padding-box|content-box)$/i.test(token)))
            || ((word || node.type === 'function') && color.test(token))
          )
        if (!permitted) return ''
        tokens.push(token)
      }
    }
    if ((property === 'background-image' && tokens.length !== 1)
      || (property === 'background-size' && (tokens.length > 2 || (tokens.length > 1 && tokens.some(token => /^(?:cover|contain)$/i.test(token)))))
      || (property === 'background-repeat' && (tokens.length > 2 || (tokens.length > 1 && tokens.some(token => /^repeat-[xy]$/i.test(token)))))
      || (property.startsWith('background-position') && tokens.length > (property === 'background-position' ? 4 : 2))) return ''
    output.push(tokens)
  }
  for (const image of images) {
    const source = filterBackgroundImage(image.source, context, signals)
    if (source) image.layer[image.index] = `url("${source}")`
  }
  return output.map(layer => layer.join(' ')).join(', ')
}

function sanitizeEmailStyleValue(property: string, value: string, context: EmailStyleContext, signals: ImageSignals): string {
  if (BACKGROUND_PROPERTIES.has(property)) return sanitizeBackgroundValue(property, value, context, signals)
  return Object.hasOwn(SAFE_EMAIL_STYLES, property) && SAFE_EMAIL_STYLES[property]!.some(pattern => pattern.test(value)) ? value : ''
}

function sanitizeInlineEmailStyles(value: string, context: EmailStyleContext, attributes: Record<string, string>): string {
  try {
    const root = postcss.parse(`email{${value}}`)
    const rule = root.nodes[0]
    if (root.nodes.length !== 1 || rule?.type !== 'rule' || rule.selector !== 'email') return ''
    const signals = emailStyleSignals(rule.nodes, attributes)
    const declarations: string[] = []
    for (const node of rule.nodes) {
      if (node.type !== 'decl' || !/^[a-z][a-z-]*$/i.test(node.prop)) continue
      const property = node.prop.toLowerCase()
      const clean = sanitizeEmailStyleValue(property, node.value.trim(), context, signals)
      if (clean) declarations.push(postcss.decl({ prop: property, value: clean, important: node.important }).toString())
    }
    return declarations.join(';')
  } catch { return '' }
}

function sanitizeEmailMediaQuery(query: string): string {
  if (!query || query.length > 512 || /[\\<>{};'"&]/.test(query) || query.includes('/*')) return ''

  const queries = query.split(',')
  if (queries.length > 8) return ''

  const normalized: string[] = []

  for (const entry of queries) {
    const parts = entry.trim().split(/\s+and\s+/i)
    if (!parts[0]) return ''

    const clauses: string[] = []
    const mediaType = parts[0].match(/^(?:(only)\s+)?(screen|all)$/i)

    if (mediaType) {
      clauses.push(`${mediaType[1] ? 'only ' : ''}${mediaType[2].toLowerCase()}`)
      parts.shift()
    }

    if (!mediaType && parts.length === 0) return ''

    for (const part of parts) {
      const feature = part.match(/^\(\s*(width|min-width|max-width|min-device-width|max-device-width|orientation|resolution|min-resolution|max-resolution|(?:-webkit-)?(?:min|max)-device-pixel-ratio|prefers-color-scheme)\s*:\s*([^)]*?)\s*\)$/i)
      if (!feature) return ''

      const name = feature[1].toLowerCase()
      const value = feature[2].trim().toLowerCase()

      if (
        (/(?:^|-)width$/.test(name) && !cssPattern(CSS_MEDIA_LENGTH).test(value)) ||
        (name === 'orientation' && !/^(?:portrait|landscape)$/.test(value)) ||
        (/(?:^|-)resolution$/.test(name) && !/^(?:\d+|\d*\.\d+)(?:dpi|dpcm|dppx|x)$/.test(value)) ||
        (/(?:^|-)pixel-ratio$/.test(name) && !/^(?:\d+|\d*\.\d+)$/.test(value)) ||
        (name === 'prefers-color-scheme' && !/^(?:light|dark)$/.test(value))
      ) return ''

      clauses.push(`(${name}: ${value})`)
    }

    if (clauses.length === 0) return ''
    normalized.push(clauses.join(' and '))
  }

  return normalized.join(', ')
}

function sanitizeEmailSelector(value: string): string {
  if (
    !value ||
    value.length > 2_048 ||
    /[\\<\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(value) ||
    value.includes('/*')
  ) return ''

  let parsed: ReturnType<ReturnType<typeof selectorParser>['astSync']>

  try {
    parsed = selectorParser().astSync(value)
  } catch {
    return ''
  }

  if (parsed.nodes.length > 32) return ''

  const safe = selectorParser.root({ value: '' })

  for (const selector of parsed.nodes) {
    if (selector.nodes.length === 0 || selector.nodes.length > 64) continue

    const normalized = selectorParser.selector({ value: '' })
    let previousWasCombinator = true
    let valid = true

    for (const node of selector.nodes) {
      if (selectorParser.isTag(node)) {
        if (node.namespace || !/^[a-z][a-z\d-]*$/i.test(node.value)) {
          valid = false
          break
        }

        normalized.append(selectorParser.tag({ value: node.value.toLowerCase() }))
        previousWasCombinator = false
      } else if (selectorParser.isClassName(node)) {
        if (!/^-?[_a-z][_a-z\d-]*$/i.test(node.value)) {
          valid = false
          break
        }

        normalized.append(selectorParser.className({ value: node.value }))
        previousWasCombinator = false
      } else if (selectorParser.isCombinator(node)) {
        if (previousWasCombinator || (node.value !== '>' && !/^\s+$/.test(node.value))) {
          valid = false
          break
        }

        normalized.append(selectorParser.combinator({ value: node.value === '>' ? '>' : ' ' }))
        previousWasCombinator = true
      } else if (selectorParser.isPseudo(node)) {
        const pseudo = node.value.toLowerCase()

        if (
          (node.nodes?.length ?? 0) > 0 ||
          !/^:(?:root|first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|empty)$/.test(pseudo)
        ) {
          valid = false
          break
        }

        normalized.append(selectorParser.pseudo({ value: pseudo }))
        previousWasCombinator = false
      } else {
        valid = false
        break
      }
    }

    if (valid && !previousWasCombinator) safe.append(normalized)
  }

  return safe.toString()
}

export function sanitizeEmailStyles(
  html: string,
  context: Pick<EmailStyleContext, 'remoteImages' | 'remoteImage' | 'contentIds' | 'trackingBackgrounds'> = {},
): string {
  if (typeof html !== 'string' || !/<style(?:\s|>)/i.test(html)) return ''

  const stylesheets: Array<{ css: string; media: string }> = []
  let current: { css: string; media: string } | null = null
  let inputBytes = 0
  let exceeded = false

  try {
    const parser = new Parser({
      onopentag(name, attributes) {
        if (name !== 'style') return
        current = null

        if (attributes.type && attributes.type.trim().toLowerCase() !== 'text/css') return

        const mediaAttribute = attributes.media?.trim() ?? ''
        const media = mediaAttribute ? sanitizeEmailMediaQuery(mediaAttribute) : ''
        if (mediaAttribute && !media) return

        current = { css: '', media: media === 'all' ? '' : media }
      },
      ontext(text) {
        if (!current || exceeded) return

        if (text.includes('<') || text.includes('\0')) {
          current = null
          return
        }

        inputBytes += Buffer.byteLength(text)
        if (inputBytes > MAX_EMAIL_STYLE_INPUT_BYTES) {
          exceeded = true
          current = null
          return
        }

        current.css += text
      },
      onclosetag(name) {
        if (name !== 'style') return
        if (current?.css.trim()) stylesheets.push(current)
        current = null
      },
    }, { decodeEntities: false })

    parser.end(html)
  } catch {
    return ''
  }

  if (exceeded || stylesheets.length === 0 || stylesheets.length > 64) return ''

  if (context.remoteImages && !context.trackingBackgrounds) {
    const trackingBackgrounds = new Set<string>()
    sanitizeEmailMarkup(inlineEmailStyles(html), false, true, { contentIds: context.contentIds, trackingBackgrounds })
    context = { ...context, trackingBackgrounds }
  }
  const output = postcss.root()
  let ruleCount = 0

  function appendRules(source: Root | AtRule, target: Root | AtRule, depth: number): void {
    for (const node of source.nodes ?? []) {
      if (node.type === 'rule') {
        if (++ruleCount > MAX_EMAIL_STYLE_RULES) {
          exceeded = true
          return
        }

        const selector = sanitizeEmailSelector(node.selector)
        if (!selector) continue

        const rule = postcss.rule({ selector })
        const signals = emailStyleSignals(node.nodes ?? [])

        for (const declaration of node.nodes ?? []) {
          if (declaration.type !== 'decl' || !/^[a-z][a-z-]*$/i.test(declaration.prop)) continue

          const property = declaration.prop.toLowerCase()
          if (declaration.value.length > 1_024) continue
          const value = sanitizeEmailStyleValue(property, declaration.value.trim(), context, signals)
          if (!value) continue

          rule.append(postcss.decl({
            prop: property,
            value,
            important: declaration.important,
          }))
        }

        if (rule.nodes.length > 0) target.append(rule)
      } else if (node.type === 'atrule') {
        if (++ruleCount > MAX_EMAIL_STYLE_RULES) {
          exceeded = true
          return
        }

        if (depth >= 3 || node.name.toLowerCase() !== 'media' || !node.nodes?.length) continue

        const params = sanitizeEmailMediaQuery(node.params)
        if (!params) continue

        const media = postcss.atRule({ name: 'media', params })
        appendRules(node, media, depth + 1)
        if (exceeded) return
        if (media.nodes?.length) target.append(media)
      }
    }
  }

  for (const stylesheet of stylesheets) {
    let parsed: Root

    try {
      parsed = postcss.parse(stylesheet.css)
    } catch {
      continue
    }

    if (stylesheet.media) {
      const media = postcss.atRule({ name: 'media', params: stylesheet.media })
      appendRules(parsed, media, 1)
      if (media.nodes?.length) output.append(media)
    } else {
      appendRules(parsed, output, 0)
    }

    if (exceeded) return ''
  }

  const css = output.toString()
  return css.includes('<') || Buffer.byteLength(css) > MAX_EMAIL_STYLE_OUTPUT_BYTES ? '' : css
}

function inlineEmailStyles(html: string): string {
  let content = html
  if (/<style(?:\s|>)/i.test(html)) {
    try {
      content = juice(html, {
        applyAttributesTableElements: false,
        applyHeightAttributes: false,
        applyWidthAttributes: false,
        insertPreservedExtraCss: false,
        preserveContainerQueries: false,
        preserveFontFaces: false,
        preserveKeyFrames: false,
        preserveLayers: false,
        preserveMediaQueries: false,
        preservePseudos: false,
        removeStyleTags: true,
      })
    } catch {
      content = html
    }
  }

  return content
}

function emailImageKey(source: string, attributes: Record<string, string>): string {
  return JSON.stringify([source, attributes.class ?? '', attributes.width ?? '', attributes.height ?? ''])
}

function sanitizeEmailMarkup(
  html: string,
  remoteImages: boolean,
  blockTracking: boolean,
  options: {
    document?: boolean
    trackingImages?: Set<string>
    contentIds?: ReadonlyMap<string, string>
    trackingBackgrounds?: Set<string>
    backgroundContent?: { value: boolean }
    remoteImage?: (source: string) => string
  } = {},
): string {
  const bodyWrappers = new WeakSet<Record<string, string>>()
  function resolveCid(value: string): string {
    const cid = value.trim().match(/^cid:(.+)$/i)?.[1]
    if (!cid || !options.contentIds) return value
    let decoded = cid
    try { decoded = decodeURIComponent(cid) } catch { /* Match malformed escapes literally. */ }
    return options.contentIds.get(cid) ?? options.contentIds.get(decoded) ?? value
  }

  return sanitizeHtml(html, {
    allowedTags: [...SAFE_EMAIL_TAGS, ...(options.document ? ['html', 'body'] : [])],
    allowedAttributes: {
      '*': ['class', 'dir', 'lang', 'title', 'aria-label', 'align', 'bgcolor', 'valign', 'role', 'style'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'data-openmail-src', 'alt', 'width', 'height', 'loading', 'title', ...(options.document ? ['data-inbox-tracking'] : [])],
      table: ['width', 'height', 'cellpadding', 'cellspacing', 'border', 'background'],
      td: ['width', 'height', 'colspan', 'rowspan', 'align', 'valign', 'background'],
      th: ['width', 'height', 'colspan', 'rowspan', 'align', 'valign', 'background'],
      font: ['color', 'face', 'size'],
      ol: ['start', 'type'],
      li: ['value'],
      source: ['media', 'type'],
      ...(options.document ? { body: ['text', 'background'] } : {}),
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'cid', 'data'],
      body: ['http', 'https', 'data'], table: ['http', 'https', 'data'],
      td: ['http', 'https', 'data'], th: ['http', 'https', 'data'],
    },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'head'],
    transformTags: {
      '*': (tagName, attributes) => {
        const context: EmailStyleContext = {
          remoteImages, contentIds: options.contentIds, trackingBackgrounds: options.trackingBackgrounds,
          remoteImage: options.remoteImage,
          onTrackingBackground: !options.document ? source => options.trackingBackgrounds?.add(source) : undefined,
          onBackgroundContent: (SAFE_EMAIL_TAGS.includes(tagName) || tagName === 'html' || tagName === 'body')
            && options.backgroundContent ? () => { options.backgroundContent!.value = true } : undefined,
        }
        const sanitized = { ...attributes }
        // Every emitted style uses the shared whitelist; URL values get AST/URI validation.
        if (attributes.style) sanitized.style = sanitizeInlineEmailStyles(attributes.style, context, attributes)
        if (attributes.background) {
          delete sanitized.background
          if (HTML_BACKGROUND_TAGS.has(tagName) || bodyWrappers.has(attributes)) {
            let signals: ImageSignals = { width: attributes.width, height: attributes.height }
            try {
              const rule = postcss.parse(`email{${attributes.style ?? ''}}`).nodes[0]
              if (rule?.type === 'rule') signals = emailStyleSignals(rule.nodes, attributes)
            } catch { /* Invalid CSS cannot supply a background tracking signal. */ }
            const source = filterBackgroundImage(resolveBackgroundImage(attributes.background, options.contentIds), context, signals)
            if (source) {
              // Native body hints need CSS in a legacy div; existing author styles still win.
              if (bodyWrappers.has(attributes)) sanitized.style = `background-image:url("${source}");${sanitized.style ?? ''}`
              else sanitized.background = source
            }
          }
        }
        return { tagName, attribs: sanitized }
      },
      body: (_tagName, attributes) => {
        // Real roots retain presentational hints without promoting them to inline CSS.
        if (options.document) return { tagName: 'body', attribs: attributes }
        const hasColorStyle = /(?:^|;)\s*(?:background(?:-color)?|color)\s*:/i
          .test(attributes.style ?? '')
        if (!hasColorStyle && !attributes.bgcolor && !attributes.text && !attributes.background) {
          return { tagName: 'body', attribs: attributes }
        }

        const style = [
          attributes.bgcolor ? `background-color:${attributes.bgcolor}` : '',
          attributes.text ? `color:${attributes.text}` : '',
          attributes.style,
        ].filter(Boolean).join(';')

        const attribs = {
          ...attributes,
          class: [attributes.class, 'openmail-email-document'].filter(Boolean).join(' '),
          style,
        }
        bodyWrappers.add(attribs)
        return { tagName: 'div', attribs }
      },
      div: (_tagName, attributes) => ({
        tagName: 'div',
        attribs: attributes.id === 'divRplyFwdMsg'
          ? {
              ...attributes,
              class: [attributes.class, 'openmail-quoted-history'].filter(Boolean).join(' '),
            }
          : attributes,
      }),
      blockquote: (_tagName, attributes) => ({
        tagName: 'blockquote',
        attribs: attributes.type?.toLowerCase() === 'cite'
          ? {
              ...attributes,
              class: [attributes.class, 'openmail-quoted-history'].filter(Boolean).join(' '),
            }
          : attributes,
      }),
      a: (_tagName, attributes) => ({
        tagName: 'a',
        attribs: { ...attributes, ...(attributes.href ? { href: resolveCid(attributes.href) } : {}), rel: 'noopener noreferrer', target: '_blank' },
      }),
      img: (_tagName, attributes) => {
        const sanitized = { ...attributes }
        delete sanitized['data-openmail-src']
        delete sanitized['data-inbox-tracking']
        const source = sanitized.src?.trim() ?? ''
        // URL parsers also accept forms such as https:host/path. They must not escape image policy.
        // Reject browser-normalized control/backslash forms while retaining valid wrapped data images.
        const malformed = /[\\\u0000-\u001f\u007f]/.test(source) && !SAFE_DATA_IMAGE.test(source)
        const remote = /^https?:/i.test(source)
        let trackingSource = source
        if (remote) try { trackingSource = new URL(source).href } catch { /* Invalid destinations fail closed at serving. */ }
        const style: Record<string, string> = {}
        if (remote && sanitized.style) {
          try {
            postcss.parse(`img{${sanitized.style}}`).walkDecls((declaration) => {
              if (['width', 'height', 'display', 'visibility', 'opacity'].includes(declaration.prop.toLowerCase())) {
                style[declaration.prop.toLowerCase()] = declaration.value.toLowerCase()
              }
            })
          } catch { /* Invalid CSS cannot supply a tracking signal. */ }
        }
        const imageKey = emailImageKey(source, sanitized)
        const trackingPixel = isTrackingImage({ src: trackingSource, width: sanitized.width, height: sanitized.height, style })
          || (options.document && options.trackingImages?.has(imageKey))
        if (!options.document && trackingPixel) options.trackingImages?.add(imageKey)

        if (malformed) {
          delete sanitized.src
        } else if (options.document && trackingPixel) {
          sanitized['data-inbox-tracking'] = 'true'
          delete sanitized.src
        } else if (remote && (!remoteImages || (blockTracking && trackingPixel))) {
          sanitized['data-openmail-src'] = source
          delete sanitized.src
        } else if (/^data:/i.test(source) && !SAFE_DATA_IMAGE.test(source)) {
          delete sanitized.src
          delete sanitized['data-openmail-src']
        }
        if (sanitized.src) sanitized.src = resolveCid(sanitized.src)
        if (sanitized.src && remote && options.remoteImage) sanitized.src = options.remoteImage(sanitized.src.trim())

        return { tagName: 'img', attribs: sanitized }
      },
    },
  })
}

export function sanitizeEmailHtml(
  html: string,
  remoteImages = true,
  blockTracking = false,
): string {
  if (typeof html !== 'string' || html.length === 0) return ''
  return sanitizeEmailMarkup(inlineEmailStyles(html), remoteImages, blockTracking)
}

export function sanitizeEmailBody(
  html: string,
  bodyText: string,
  remoteImages = false,
  blockTracking = true,
  attachments: ReadonlyArray<{ id: string; contentId?: string }> = [],
  remoteImage?: (source: string) => string,
): {
  bodyHtml: string
  bodyFormat: 'html' | 'text'
  bodyDocument?: { html: string; styles: string }
} {
  if (typeof html === 'string' && html.trim()) {
    const contentIds = new Map(attachments.filter(blob => blob.contentId).map(blob => [
      blob.contentId!, `/v1/blobs/${encodeURIComponent(blob.id)}`,
    ]))
    // Collect actual inlined tracking signals, independently of the remote-image policy.
    const trackingImages = new Set<string>()
    const trackingBackgrounds = new Set<string>()
    const backgroundContent = { value: false }
    const bodyHtml = sanitizeEmailMarkup(inlineEmailStyles(html), remoteImages, blockTracking, { contentIds, trackingImages, trackingBackgrounds, backgroundContent, remoteImage })
    const documentHtml = sanitizeEmailMarkup(html, remoteImages, blockTracking, { document: true, trackingImages, contentIds, trackingBackgrounds, backgroundContent, remoteImage })
    const styles = sanitizeEmailStyles(html, { remoteImages, contentIds, trackingBackgrounds, remoteImage })
    let hasContent = backgroundContent.value || /\burl\(/i.test(styles)
    new Parser({
      ontext(text) {
        if (text.replace(/[\s\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')) hasContent = true
      },
      onopentag(name, attributes) {
        if (name === 'img' && attributes['data-inbox-tracking'] !== 'true'
          && (attributes.src || attributes['data-openmail-src'] || attributes.alt?.trim())) hasContent = true
      },
    }).end(documentHtml)
    if (hasContent) return {
      bodyHtml,
      bodyFormat: 'html',
      bodyDocument: { html: documentHtml, styles },
    }
  }

  const text = typeof bodyText === 'string' ? bodyText : ''
  return {
    bodyHtml: sanitizeEmailHtml(`<pre>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`, remoteImages, blockTracking),
    bodyFormat: 'text',
  }
}

export const sanitizeHtmlContent = sanitizeEmailHtml

export const MAX_SVG_IMAGE_BYTES = 256 * 1024

type SvgNode = {
  name: string
  weight: number
  attributes: Record<string, string>
  children: Array<SvgNode | string>
  references: Array<{ id: string; kind: 'paint' | 'clip' | 'use' | 'gradient' }>
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const SVG_ID = /^[a-z\d_.:-]{1,128}$/i
const SVG_NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?'
const SVG_FIELDS: Record<string, string[]> = {
  svg: ['x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'version'],
  g: ['transform'], defs: [], symbol: ['viewBox', 'preserveAspectRatio'],
  clipPath: ['clipPathUnits', 'transform'],
  path: ['d', 'pathLength', 'transform'], rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'pathLength', 'transform'],
  circle: ['cx', 'cy', 'r', 'pathLength', 'transform'], ellipse: ['cx', 'cy', 'rx', 'ry', 'pathLength', 'transform'],
  line: ['x1', 'y1', 'x2', 'y2', 'pathLength', 'transform'],
  polyline: ['points', 'pathLength', 'transform'], polygon: ['points', 'pathLength', 'transform'],
  use: ['href', 'x', 'y', 'width', 'height', 'transform'],
  linearGradient: ['href', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'x1', 'y1', 'x2', 'y2'],
  radialGradient: ['href', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'cx', 'cy', 'r', 'fx', 'fy', 'fr'],
  stop: ['offset'], text: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'transform'],
  tspan: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust'], title: [], desc: [], style: ['type'],
}
const SVG_PAINT: Record<string, RegExp> = {
  color, 'stop-color': color, 'fill-rule': /^(?:nonzero|evenodd)$/, 'clip-rule': /^(?:nonzero|evenodd)$/,
  'stroke-linecap': /^(?:butt|round|square)$/, 'stroke-linejoin': /^(?:miter|round|bevel|arcs|miter-clip)$/,
  'vector-effect': /^(?:none|non-scaling-stroke)$/, 'paint-order': /^(?:normal|fill(?: stroke)?|stroke(?: fill)?)$/,
  display: /^(?:inline|none)$/, visibility: /^(?:visible|hidden|collapse)$/,
  'font-family': SAFE_EMAIL_STYLES['font-family']![0]!, 'font-weight': SAFE_EMAIL_STYLES['font-weight']![0]!,
  'font-style': SAFE_EMAIL_STYLES['font-style']![0]!, 'text-anchor': /^(?:start|middle|end)$/,
  'dominant-baseline': /^(?:auto|alphabetic|middle|central|hanging|text-after-edge|text-before-edge|ideographic)$/,
}

/** Strict XML -> a rebuilt static vector document, never an HTML/regex cleanup of the original XML.
 * No DTD/entities beyond XML's built-ins, processing instructions, scripting, animation, links,
 * image/font subresources, filters, masks or patterns. Paint/use references stay inside this tree.
 */
export function sanitizeSvgImage(input: string): string | null {
  try {
    if (Buffer.byteLength(input) > MAX_SVG_IMAGE_BYTES) return null
    function fail(): never { throw new Error('Invalid static SVG') }
    const stack: SvgNode[] = [], nodes: SvgNode[] = [], ids = new Map<string, SvgNode>()
    let root: SvgNode | undefined, numbers = 0, styleBytes = 0, rules = 0, attributeBytes = 0, textCharacters = 0
    const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    function number(value: string, units = false): number {
      const match = new RegExp(`^(${SVG_NUMBER})${units ? '(px|%)?' : ''}$`).exec(value)
      const result = match ? Number(match[1]) : NaN
      if (!Number.isFinite(result) || Math.abs(result) > 1_000_000 || ++numbers > 20_000) fail()
      return result
    }
    function list(value: string, maximum = 256, units = false): number[] {
      const parts = value.trim().split(/[\s,]+/)
      if (!parts[0] || parts.length > maximum) fail()
      return parts.map(part => number(part, units))
    }
    function reference(value: string, node: SvgNode, kind: SvgNode['references'][number]['kind']): string {
      value = value.trim()
      if (!value.startsWith('#') || !SVG_ID.test(value.slice(1))) fail()
      node.references.push({ id: value.slice(1), kind })
      return value
    }
    function transform(value: string): string {
      const counts: Record<string, number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] }
      if (value === 'none') return value
      const parsed = valueParser(value)
      if (!parsed.nodes.length || parsed.nodes.length > 64) fail()
      for (const token of parsed.nodes) {
        if (token.type === 'space') continue
        if (token.type !== 'function' || token.unclosed || !Object.hasOwn(counts, token.value)) fail()
        if (!counts[token.value]!.includes(list(valueParser.stringify(token.nodes), 6).length)) fail()
      }
      return value
    }
    function paint(property: string, value: string, node: SvgNode): string {
      value = value.trim()
      if (!value || value.length > 2048 || /[\\\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/.test(value)) fail()
      if (property === 'fill' || property === 'stroke' || property === 'clip-path') {
        const tokens = valueParser(value).nodes.filter(token => token.type !== 'space')
        if (tokens[0]?.type === 'function' && tokens[0].value.toLowerCase() === 'url') {
          const fn = tokens[0]
          const inner = fn.nodes.filter(token => token.type !== 'space')
          if (fn.unclosed || inner.length !== 1 || !['word', 'string'].includes(inner[0]!.type) || tokens.length > 2) fail()
          const target = reference(inner[0]!.value, node, property === 'clip-path' ? 'clip' : 'paint')
          const fallback = tokens[1] ? valueParser.stringify(tokens.slice(1)) : ''
          if (fallback && (property === 'clip-path' || !color.test(fallback))) fail()
          return `url("${target}")${fallback ? ` ${fallback}` : ''}`
        }
        if (property === 'clip-path' ? value !== 'none' : !color.test(value)) fail()
      } else if (Object.hasOwn(SVG_PAINT, property)) {
        if (!SVG_PAINT[property]!.test(value)) fail()
      } else if (['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity'].includes(property)) {
        const n = number(value, true)
        if (value.endsWith('px') || n < 0 || n > (value.endsWith('%') ? 100 : 1)) fail()
      } else if (['stroke-width', 'stroke-dashoffset', 'stroke-miterlimit', 'font-size', 'letter-spacing', 'word-spacing'].includes(property)) {
        const n = number(value, true)
        if (Math.abs(n) > 16384 || ['stroke-width', 'stroke-miterlimit', 'font-size'].includes(property) && n < 0) fail()
        if (property === 'font-size' && (value.endsWith('%') || n > 512)) fail()
        if (property === 'stroke-dashoffset' && n !== 0) fail()
      } else if (property === 'stroke-dasharray') {
        // Tiny repeated dashes can explode paint work independently of XML/path byte counts.
        if (value !== 'none') fail()
      } else if (property === 'transform') transform(value)
      else if (property === 'enable-background') {
        // Deprecated filter backdrop allocation is unnecessary for the permitted vector-only subset.
        if (value !== 'accumulate') { if (!value.startsWith('new ') || list(value.slice(4), 4).length !== 4) fail() }
        return ''
      } else fail()
      return value
    }
    function declarations(source: Root | AtRule | Rule, node: SvgNode): Declaration[] {
      const result: Declaration[] = []
      for (const child of source.nodes ?? []) {
        if (child.type === 'comment') continue
        if (child.type !== 'decl' || !/^[a-z-]+$/i.test(child.prop)) fail()
        const value = paint(child.prop.toLowerCase(), child.value, node)
        if (value) result.push(postcss.decl({ prop: child.prop.toLowerCase(), value, important: child.important, raws: { before: '', between: ':' } }))
      }
      return result
    }
    function styles(value: string, node: SvgNode, inline: boolean): string {
      styleBytes += Buffer.byteLength(value)
      if (styleBytes > 32 * 1024) fail()
      const parsed = postcss.parse(inline ? `svg{${value}}` : value)
      if (inline) {
        if (parsed.nodes.length !== 1 || parsed.nodes[0]?.type !== 'rule') fail()
        return declarations(parsed.nodes[0], node).map(declaration => declaration.toString()).join(';')
      }
      const output = postcss.root()
      for (const child of parsed.nodes) {
        if (child.type === 'comment') continue
        if (child.type !== 'rule' || ++rules > 128 || child.selector.length > 512 || child.selector.includes('\\')) fail()
        const selectors = selectorParser().astSync(child.selector)
        if (selectors.nodes.length > 32) fail()
        let selectorNodes = 0
        selectors.walk(token => {
          if (++selectorNodes > 64) fail()
          if (!['selector', 'tag', 'class', 'id', 'universal', 'combinator'].includes(token.type)) fail()
          if ('namespace' in token && token.namespace) fail()
          // Direct-child matching is bounded; no descendant/pseudo-selector backtracking.
          if (token.type === 'combinator' && token.value.trim() !== '>') fail()
          if (token.type === 'tag' && !Object.hasOwn(SVG_FIELDS, token.value)) fail()
          if ((token.type === 'class' || token.type === 'id') && !SVG_ID.test(token.value)) fail()
        })
        const rule = postcss.rule({ selector: selectors.toString(), raws: { before: '', between: '', after: '', semicolon: false } })
        rule.append(...declarations(child, node))
        if (rule.nodes?.length) output.append(rule)
      }
      return output.toString()
    }
    function attribute(name: string, value: string, node: SvgNode): string | undefined {
      // Exporters use non-ASCII names for unreferenced layer IDs. IDs are escaped metadata,
      // not URI/code sinks; references and CSS selectors still use the stricter grammar above.
      if (name === 'id') { if (!value || value.length > 128 || ids.has(value)) fail(); ids.set(value, node); return value }
      value = value.trim()
      if (name === 'class') { if (value.length > 512 || !value.split(/\s+/).every(part => SVG_ID.test(part))) fail(); return value }
      if (name === 'style') return styles(value, node, true) || undefined
      if (name === 'aria-label') return value
      if (name === 'role') { if (!['img', 'presentation', 'none'].includes(value)) fail(); return value }
      if (name.startsWith('data-')) return undefined
      if (SVG_FIELDS[node.name]!.includes(name)) {
        if (name === 'href') return reference(value, node, node.name === 'use' ? 'use' : 'gradient')
        if (name === 'type') { if (value !== 'text/css') fail() }
        else if (name === 'version') { if (!['1.0', '1.1', '2.0'].includes(value)) fail() }
        else if (name === 'preserveAspectRatio') { if (!/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$/.test(value)) fail() }
        else if (name === 'gradientUnits' || name === 'clipPathUnits') { if (!['userSpaceOnUse', 'objectBoundingBox'].includes(value)) fail() }
        else if (name === 'spreadMethod') { if (!['pad', 'reflect', 'repeat'].includes(value)) fail() }
        else if (name === 'lengthAdjust') { if (!['spacing', 'spacingAndGlyphs'].includes(value)) fail() }
        else if (name === 'transform' || name === 'gradientTransform') transform(value)
        else if (name === 'd') {
          const tokens = value.match(new RegExp(`${SVG_NUMBER}|[MmZzLlHhVvCcSsQqTtAa]`, 'g')) ?? []
          if (!tokens.length || tokens.join('') !== value.replace(/[\s,]/g, '')) fail()
          node.weight += tokens.length
          for (const token of tokens) if (!/^[a-z]$/i.test(token)) number(token)
        } else if (name === 'viewBox') {
          const box = list(value, 4)
          if (box.length !== 4 || box[2]! < 0.000001 || box[3]! < 0.000001 || box[2]! > 16384 || box[3]! > 16384 || box[2]! * box[3]! > 32_000_000) fail()
        } else if (name === 'offset') {
          const n = number(value, true)
          if (value.endsWith('px') || n < 0 || n > (value.endsWith('%') ? 100 : 1)) fail()
        } else if (name === 'points') {
          const points = value.match(new RegExp(SVG_NUMBER, 'g')) ?? []
          if (!points.length || points.length > 8192 || points.length % 2 || points.join('') !== value.replace(/[\s,]/g, '')) fail()
          for (const point of points) number(point)
          node.weight += points.length
        }
        else list(value, 256, true)
        return value
      }
      return paint(name, value, node) || undefined
    }
    const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: '1.0', forceXMLVersion: true, position: false })
    parser.on('error', fail)
    parser.on('doctype', fail)
    parser.on('processinginstruction', fail)
    parser.on('xmldecl', declaration => {
      if (declaration.version !== '1.0' || declaration.encoding && !/^(?:utf-8|us-ascii)$/i.test(declaration.encoding)) fail()
    })
    parser.on('opentag', tag => {
      if (tag.uri !== SVG_NAMESPACE || !Object.hasOwn(SVG_FIELDS, tag.local) || nodes.length >= 1024 || stack.length >= 32) fail()
      if ((!root && tag.local !== 'svg') || root && tag.local === 'svg') fail()
      const parent = stack.at(-1)
      if (parent && (['style', 'title', 'desc'].includes(parent.name)
        || ['linearGradient', 'radialGradient'].includes(parent.name) && !['stop', 'title', 'desc'].includes(tag.local)
        || ['text', 'tspan'].includes(parent.name) && !['tspan', 'title', 'desc'].includes(tag.local)
        || !['svg', 'g', 'defs', 'symbol', 'clipPath', 'linearGradient', 'radialGradient', 'text', 'tspan'].includes(parent.name) && !['title', 'desc'].includes(tag.local))) fail()
      const node: SvgNode = { name: tag.local, weight: 1, attributes: {}, children: [], references: [] }
      const attributes = Object.values(tag.attributes)
      if (attributes.length > 32) fail()
      for (const attr of attributes) {
        if (attr.uri === 'http://www.w3.org/2000/xmlns/') continue
        attributeBytes += attr.value.length
        if (attributeBytes > 192 * 1024 || attr.value.length > (attr.local === 'd' ? 64 * 1024 : 8192)) fail()
        let name = attr.local, value: string | undefined
        if (attr.uri === 'http://www.w3.org/XML/1998/namespace' && name === 'space') {
          if (!['default', 'preserve'].includes(attr.value)) fail()
          name = 'xml:space'; value = attr.value
        } else {
          if (attr.uri && !(attr.uri === 'http://www.w3.org/1999/xlink' && name === 'href')) fail()
          value = attribute(name, attr.value, node)
        }
        if (Object.hasOwn(node.attributes, name)) fail()
        if (value !== undefined) node.attributes[name] = value
      }
      if (parent) parent.children.push(node)
      else root = node
      nodes.push(node); stack.push(node)
    })
    const text = (value: string) => {
      const node = stack.at(-1)
      if (!node) { if (value.trim()) fail(); return }
      if (value.trim() && !['text', 'tspan', 'title', 'desc', 'style'].includes(node.name)) fail()
      if (node.name === 'text' || node.name === 'tspan') {
        textCharacters += value.length; node.weight += value.length
        if (textCharacters > 1024) fail()
      }
      node.children.push(value)
    }
    parser.on('text', text)
    parser.on('cdata', text)
    parser.on('closetag', () => {
      const node = stack.pop()
      if (!node) fail()
      if (node.name === 'style') node.children = [styles(node.children.join(''), node, false)]
    })
    parser.write(input).close()
    if (!root || stack.length) fail()
    const document: SvgNode = root
    const box = document.attributes.viewBox ? list(document.attributes.viewBox, 4) : undefined
    const dimension = (value: string | undefined) => {
      if (value === undefined) return undefined
      const n = number(value, true)
      if (n <= 0 || value.endsWith('%') && (!box || n > 100)) fail()
      return value.endsWith('%') ? undefined : n
    }
    let width = dimension(document.attributes.width), height = dimension(document.attributes.height)
    if (box) {
      if (width !== undefined && height === undefined) height = width * box[3]! / box[2]!
      else if (height !== undefined && width === undefined) width = height * box[2]! / box[3]!
    }
    width ??= box?.[2] ?? 300; height ??= box?.[3] ?? 150
    if (width > 16384 || height > 16384 || width * height > 32_000_000) fail()
    const visiting = new Set<SvgNode>(), costs = new Map<SvgNode, number>()
    const cost = (node: SvgNode): number => {
      if (visiting.has(node)) fail()
      const known = costs.get(node)
      if (known !== undefined) return known
      visiting.add(node)
      let total = node.weight
      for (const child of node.children) if (typeof child !== 'string') total += cost(child)
      for (const ref of node.references) {
        const target = ids.get(ref.id)
        if (!target || ref.kind === 'clip' && target.name !== 'clipPath'
          || ['paint', 'gradient'].includes(ref.kind) && !['linearGradient', 'radialGradient'].includes(target.name)
          || ref.kind === 'use' && !['g', 'symbol', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'use'].includes(target.name)) fail()
        total += cost(target)
        if (total > 8192) fail()
      }
      if (total > 8192) fail()
      visiting.delete(node); costs.set(node, total)
      return total
    }
    cost(document)
    const serialize = (node: SvgNode): string => {
      const attributes = Object.entries(node.attributes).map(([name, value]) => ` ${name}="${escape(value).replaceAll('"', '&quot;').replaceAll('\t', '&#9;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;')}"`).join('')
      const open = `<${node.name}${node === document ? ` xmlns="${SVG_NAMESPACE}"` : ''}${attributes}`
      return node.children.length ? `${open}>${node.children.map(child => typeof child === 'string' ? escape(child).replaceAll('\r', '&#13;') : serialize(child)).join('')}</${node.name}>` : `${open}/>`
    }
    const output = serialize(document)
    return Buffer.byteLength(output) <= MAX_SVG_IMAGE_BYTES ? output : null
  } catch { return null }
}
