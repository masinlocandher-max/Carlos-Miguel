/**
 * Jewel OS - minimal schema validation.
 *
 * Every tool declares a schema. Arguments are validated and COERCED to the
 * declared shape before a tool runs, so a model cannot smuggle extra fields
 * into a provider call. Unknown keys are rejected, not ignored - an unexpected
 * field is a signal, not noise.
 *
 * Supported: string, number, integer, boolean, array, object, enum, const,
 * plus required/optional, min/max, pattern, format and nested objects/arrays.
 */
import { ValidationError } from './errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

const FORMATS = {
  email: (v) => EMAIL_RE.test(v),
  'date-time': (v) => ISO_RE.test(v) && !Number.isNaN(Date.parse(v)),
  url: (v) => URL_RE.test(v),
  id: (v) => /^[A-Za-z0-9._:-]{1,200}$/.test(v),
};

/**
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {unknown} coerced value
 */
export function validate(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object') return value;

  if (typeof value === 'undefined' || value === null) {
    if ('default' in schema) return structuredClone(schema.default);
    if (schema.nullable) return null;
    throw new ValidationError(`${path} is required`, { path, expected: schema.type });
  }

  if (schema.const !== undefined) {
    if (value !== schema.const) throw new ValidationError(`${path} must equal ${JSON.stringify(schema.const)}`, { path });
    return value;
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      throw new ValidationError(`${path} must be one of: ${schema.enum.join(', ')}`, { path, allowed: schema.enum });
    }
    return value;
  }

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') throw new ValidationError(`${path} must be a string`, { path });
      if (schema.minLength != null && value.length < schema.minLength) throw new ValidationError(`${path} must be at least ${schema.minLength} characters`, { path });
      if (schema.maxLength != null && value.length > schema.maxLength) throw new ValidationError(`${path} must be at most ${schema.maxLength} characters`, { path });
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new ValidationError(`${path} does not match the required format`, { path });
      if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format](value)) {
        throw new ValidationError(`${path} is not a valid ${schema.format}`, { path });
      }
      return value;
    }
    case 'integer':
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || Number.isNaN(n)) throw new ValidationError(`${path} must be a number`, { path });
      if (schema.type === 'integer' && !Number.isInteger(n)) throw new ValidationError(`${path} must be an integer`, { path });
      if (schema.minimum != null && n < schema.minimum) throw new ValidationError(`${path} must be >= ${schema.minimum}`, { path });
      if (schema.maximum != null && n > schema.maximum) throw new ValidationError(`${path} must be <= ${schema.maximum}`, { path });
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new ValidationError(`${path} must be a boolean`, { path });
    }
    case 'array': {
      if (!Array.isArray(value)) throw new ValidationError(`${path} must be an array`, { path });
      if (schema.minItems != null && value.length < schema.minItems) throw new ValidationError(`${path} needs at least ${schema.minItems} item(s)`, { path });
      if (schema.maxItems != null && value.length > schema.maxItems) throw new ValidationError(`${path} allows at most ${schema.maxItems} item(s)`, { path });
      return schema.items ? value.map((v, i) => validate(schema.items, v, `${path}[${i}]`)) : value;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${path} must be an object`, { path });
      const props = schema.properties ?? {};
      const required = schema.required ?? Object.keys(props).filter((k) => !props[k].optional && !('default' in props[k]));
      const out = {};

      if (schema.additionalProperties !== true) {
        const unknown = Object.keys(value).filter((k) => !(k in props));
        if (unknown.length) {
          throw new ValidationError(`${path} has unexpected field(s): ${unknown.join(', ')}`, { path, unknown });
        }
      } else {
        for (const [k, v] of Object.entries(value)) if (!(k in props)) out[k] = v;
      }

      for (const [key, sub] of Object.entries(props)) {
        const present = key in value && typeof value[key] !== 'undefined';
        if (!present) {
          if (required.includes(key)) throw new ValidationError(`${path}.${key} is required`, { path: `${path}.${key}` });
          if ('default' in sub) out[key] = structuredClone(sub.default);
          continue;
        }
        out[key] = validate(sub, value[key], `${path}.${key}`);
      }
      return out;
    }
    case 'any':
    case undefined:
      return value;
    default:
      throw new ValidationError(`Unsupported schema type "${schema.type}" at ${path}`, { path });
  }
}

/** Convenience: object schema builder used across tool definitions. */
export function object(properties, opts = {}) {
  return { type: 'object', properties, additionalProperties: false, ...opts };
}
export const str = (o = {}) => ({ type: 'string', ...o });
export const num = (o = {}) => ({ type: 'number', ...o });
export const int = (o = {}) => ({ type: 'integer', ...o });
export const bool = (o = {}) => ({ type: 'boolean', ...o });
export const arr = (items, o = {}) => ({ type: 'array', items, ...o });
