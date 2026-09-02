import { Parser } from 'htmlparser2'
import juice from 'juice'
import postcss, { type AtRule, type Root } from 'postcss'
import selectorParser from 'postcss-selector-parser'
import sanitizeHtml from 'sanitize-html'
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
const CSS_FONT_NAME = "(?:-?[a-z\\d][a-z\\d _-]*|\"[a-z\\d][a-z\\d _-]*\"|'[a-z\\d][a-z\\d _-]*')"

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

export function sanitizeEmailStyles(html: string): string {
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

        for (const declaration of node.nodes ?? []) {
          if (declaration.type !== 'decl' || !/^[a-z][a-z-]*$/i.test(declaration.prop)) continue

          const property = declaration.prop.toLowerCase()
          const patterns = SAFE_EMAIL_STYLES[property]
          const value = declaration.value.trim()

          if (
            !patterns ||
            !value ||
            value.length > 1_024 ||
            value.includes('<') ||
            value.includes('\\') ||
            !patterns.some((pattern) => pattern.test(value))
          ) continue

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

export function sanitizeEmailHtml(
  html: string,
  remoteImages = true,
  blockTracking = false,
): string {
  if (typeof html !== 'string' || html.length === 0) return ''

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

  return sanitizeHtml(content, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'figure',
      'figcaption',
      'font',
      'picture',
      's',
      'source',
      'strike',
    ],
    allowedAttributes: {
      '*': ['class', 'dir', 'lang', 'title', 'aria-label', 'align', 'bgcolor', 'valign', 'role', 'style'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'data-openmail-src', 'alt', 'width', 'height', 'loading', 'title'],
      table: ['width', 'height', 'cellpadding', 'cellspacing', 'border'],
      td: ['width', 'height', 'colspan', 'rowspan', 'align', 'valign'],
      th: ['width', 'height', 'colspan', 'rowspan', 'align', 'valign'],
      font: ['color', 'face', 'size'],
      ol: ['start', 'type'],
      li: ['value'],
      source: ['media', 'type'],
    },
    allowedStyles: { '*': SAFE_EMAIL_STYLES },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'head'],
    transformTags: {
      body: (_tagName, attributes) => {
        const hasColorStyle = /(?:^|;)\s*(?:background(?:-color)?|color)\s*:/i
          .test(attributes.style ?? '')
        if (!hasColorStyle && !attributes.bgcolor && !attributes.text) {
          return { tagName: 'body', attribs: attributes }
        }

        const style = [
          attributes.bgcolor ? `background-color:${attributes.bgcolor}` : '',
          attributes.text ? `color:${attributes.text}` : '',
          attributes.style,
        ].filter(Boolean).join(';')

        return {
          tagName: 'div',
          attribs: {
            ...attributes,
            class: [attributes.class, 'openmail-email-document'].filter(Boolean).join(' '),
            style,
          },
        }
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
        attribs: { ...attributes, rel: 'noopener noreferrer', target: '_blank' },
      }),
      img: (_tagName, attributes) => {
        const sanitized = { ...attributes }
        delete sanitized['data-openmail-src']
        const source = sanitized.src?.trim() ?? ''

        const remote = /^https?:\/\//i.test(source)
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
        const trackingPixel = isTrackingImage({ src: source, width: sanitized.width, height: sanitized.height, style })

        if (remote && (!remoteImages || (blockTracking && trackingPixel))) {
          sanitized['data-openmail-src'] = source
          delete sanitized.src
        } else if (/^data:/i.test(source) && !SAFE_DATA_IMAGE.test(source)) {
          delete sanitized.src
          delete sanitized['data-openmail-src']
        }

        return { tagName: 'img', attribs: sanitized }
      },
    },
  })
}

export const sanitizeHtmlContent = sanitizeEmailHtml
