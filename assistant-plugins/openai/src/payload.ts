import { fail, object } from './errors.js';

const allowedFields = new Set([
  'model', 'input', 'store', 'stream', 'instructions', 'tools', 'tool_choice',
  'parallel_tool_calls', 'reasoning', 'include', 'prompt_cache_key', 'text',
]);

function checkTools(value: unknown, nested = false): void {
  if (!Array.isArray(value)) fail('invalid_tools', 'Tools must be an array.', 'configuration');
  for (const tool of value) {
    const item = object(tool);
    if (item.type === 'namespace' && !nested && typeof item.name === 'string') {
      checkTools(item.tools, true);
    } else if (!nested || (item.type !== 'function' && item.type !== 'custom')) {
      fail('unsupported_tool', 'ChatGPT plan usage supports only local function/custom tools in namespaces.', 'configuration');
    }
  }
}

/** Last check before sending to OpenAI. Reject rather than silently weakening request semantics. */
export function validatePlanRequest(value: unknown): Record<string, unknown> {
  const body = object(value);
  for (const key of Object.keys(body)) {
    if (!allowedFields.has(key)) fail('unsupported_parameter', 'Unsupported ChatGPT plan parameter: ' + key, 'configuration');
  }
  if (body.store !== false || body.stream !== true || !Array.isArray(body.input) || typeof body.model !== 'string') {
    fail('invalid_request', 'ChatGPT plan requests require a model, input array, store:false and stream:true.', 'configuration');
  }
  if (body.tools !== undefined) checkTools(body.tools);
  for (const raw of body.input) {
    const item = object(raw);
    if (item.role === 'system') fail('unsupported_system_role', 'Use developer messages or instructions for system guidance.', 'configuration');
    if (item.type === 'additional_tools') checkTools(item.tools);
    if (Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        const part = object(rawPart);
        if (typeof part.type === 'string' && /audio|video/.test(part.type)) {
          fail('unsupported_input', 'Audio and video are unavailable for ChatGPT plan usage.', 'configuration');
        }
      }
    }
  }
  return body;
}

/** Convert the existing pi payload into the plan route's tool namespace, without changing names. */
export function preparePlanPayload(value: unknown): Record<string, unknown> {
  // pi leaves optional fields present with `undefined`; JSON would omit them on the wire.
  const body = Object.fromEntries(Object.entries(object(value)).filter(([, item]) => item !== undefined));
  if (Array.isArray(body.tools) && body.tools.length) {
    body.tools = [{ type: 'namespace', name: 'inferos', description: 'InferOS sandbox tools', tools: body.tools }];
  }
  if (Array.isArray(body.input)) {
    body.input = body.input.map(raw => {
      const item = object(raw);
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        return { ...item, namespace: item.namespace ?? 'inferos' };
      }
      return raw;
    });
  }
  return validatePlanRequest(body);
}
