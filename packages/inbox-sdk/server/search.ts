export interface CompiledMailSearch {
  clauses: string[]
  params: Array<string | number>
  sql: string
}

function tokenize(value: string): string[] {
  return [...value.matchAll(/(?:[^\s"]|"[^"]*")+/g)]
    .map((match) => match[0].replaceAll('"', '').trim())
    .filter(Boolean)
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

export function compileMailSearch(input: string, alias = 'm'): CompiledMailSearch {
  if (!/^[A-Za-z_][A-Za-z\d_]*$/.test(alias)) {
    throw new Error('Invalid mail search table alias')
  }

  const clauses: string[] = []
  const params: Array<string | number> = []

  for (const token of tokenize(input.trim())) {
    const separator = token.indexOf(':')
    const operator = separator > 0 ? token.slice(0, separator).toLowerCase() : ''
    const value = separator > 0 ? token.slice(separator + 1).trim() : token
    if (!value) continue
    const pattern = `%${escapeLike(value)}%`

    switch (operator) {
      case 'from':
        clauses.push(`(${alias}.from_json LIKE ? ESCAPE '\\')`)
        params.push(pattern)
        break
      case 'to':
        clauses.push(`(${alias}.to_json LIKE ? ESCAPE '\\' OR ${alias}.cc_json LIKE ? ESCAPE '\\')`)
        params.push(pattern, pattern)
        break
      case 'subject':
        clauses.push(`(${alias}.subject LIKE ? ESCAPE '\\')`)
        params.push(pattern)
        break
      case 'label':
        clauses.push(`EXISTS (SELECT 1 FROM json_each(${alias}.labels_json) WHERE value LIKE ? ESCAPE '\\')`)
        params.push(pattern)
        break
      case 'has':
        if (value === 'attachment' || value === 'attachments') {
          clauses.push(`json_array_length(${alias}.attachments_json) > 0`)
        }
        break
      case 'is':
        if (value === 'unread') clauses.push(`${alias}.is_read = 0`)
        if (value === 'read') clauses.push(`${alias}.is_read = 1`)
        if (value === 'starred') clauses.push(`${alias}.is_starred = 1`)
        break
      case 'in':
        clauses.push(`${alias}.folder = ?`)
        params.push(value)
        break
      case 'before':
      case 'after': {
        const timestamp = Date.parse(value)
        if (!Number.isNaN(timestamp)) {
          clauses.push(`${alias}.received_at ${operator === 'before' ? '<' : '>='} ?`)
          params.push(new Date(timestamp).toISOString())
        }
        break
      }
      default:
        clauses.push(`(${alias}.subject LIKE ? ESCAPE '\\' OR ${alias}.preview LIKE ? ESCAPE '\\' OR ${alias}.from_json LIKE ? ESCAPE '\\' OR ${alias}.body_text LIKE ? ESCAPE '\\')`)
        params.push(pattern, pattern, pattern, pattern)
    }
  }

  return { clauses, params, sql: clauses.join(' AND ') }
}
