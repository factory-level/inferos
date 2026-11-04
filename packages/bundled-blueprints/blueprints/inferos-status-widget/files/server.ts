// The Status Widget's Durable Object. The widget's state lives in the Workshop (its declared
// states.json, one person's state of one placed widget), not here, so the server holds nothing.
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {}
