/**
 * Tool registry + light-weight JSON Schema validation (draft-07 subset).
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue }

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, { type: string; description?: string; enum?: string[]; default?: unknown; items?: { type: string } }>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`)
    }
    this.tools.set(def.name, def)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): { name: string; description: string; inputSchema: ToolInputSchema }[] {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }))
  }

  async call(name: string, rawArgs: unknown): Promise<unknown> {
    const def = this.tools.get(name)
    if (!def) {
      throw new Error(`Unknown tool: ${name}`)
    }
    const args = validateArgs(def.inputSchema, (rawArgs ?? {}) as Record<string, unknown>)
    return await def.handler(args)
  }
}

export function validateArgs(
  schema: ToolInputSchema,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args }
  for (const key of schema.required ?? []) {
    if (out[key] === undefined) {
      throw new Error(`Missing required argument: ${key}`)
    }
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const val = out[key]
    if (val === undefined) {
      if (spec.default !== undefined) out[key] = spec.default
      continue
    }
    if (!checkType(val, spec.type)) {
      throw new Error(
        `Argument "${key}" must be ${spec.type} (got ${Array.isArray(val) ? 'array' : typeof val})`,
      )
    }
    if (spec.enum && !spec.enum.includes(val as string)) {
      throw new Error(`Argument "${key}" must be one of: ${spec.enum.join(', ')}`)
    }
  }
  return out
}

function checkType(v: unknown, t: string): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string'
    case 'number':
      return typeof v === 'number' && !Number.isNaN(v)
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v)
    case 'array':
      return Array.isArray(v)
    default:
      return true
  }
}

export function jsonSchemaFor(def: ToolDefinition): ToolInputSchema {
  return def.inputSchema
}
