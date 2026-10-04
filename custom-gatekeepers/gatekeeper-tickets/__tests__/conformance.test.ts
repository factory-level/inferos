// The shared connection conformance suite, run against the queue gatekeeper. The cases are
// defined once in `@gadgets/gatekeeper-kit/conformance`; this package supplies only the adapter.

import { beforeEach, describe, it } from "vitest";
import { defineConformanceSuite } from "@gadgets/gatekeeper-kit/conformance";
import { queueAdapter } from "./conformance-adapter";

defineConformanceSuite(queueAdapter, { describe, it, beforeEach });
