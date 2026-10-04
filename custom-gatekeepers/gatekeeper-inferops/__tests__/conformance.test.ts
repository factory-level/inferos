// The shared connection conformance suite, run against the project-board gatekeeper. The cases are
// defined once in `@gadgets/gatekeeper-kit/conformance`; this package supplies only the adapter.

import { beforeEach, describe, it } from "vitest";
import { defineConformanceSuite } from "@gadgets/gatekeeper-kit/conformance";
import { inferOpsBoardAdapter } from "./conformance-adapter";

defineConformanceSuite(inferOpsBoardAdapter, { describe, it, beforeEach });
