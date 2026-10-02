import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  InferOpsProjectConfiguratorRpc,
  InferOpsProjectConfiguratorValues,
} from "./project-configurator-types";

// Duplicates the grammar in ../resources.ts on purpose: build-gatekeeper-configurator.ts transpiles
// this file on its own, so it cannot import runtime helpers. __tests__/resources.test.ts keeps
// the two in step.
const BOARD_URL = /^inferops:\/\/([^/?#]+)\/project\/board\/([^/?#]+)\/?$/;

export default {
  initial: { host: null, projectKey: null },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const match = BOARD_URL.exec(resourceUrl.trim());
    return match ? { host: match[1]!.toLowerCase(), projectKey: match[2]! } : {};
  },

  isReady({ values }) {
    return typeof values.projectKey === "string" && values.projectKey.length > 0;
  },

  async resourceUrl({ values, ui }) {
    return `inferops://${values.host || await ui.defaultHost()}/project/board/${values.projectKey}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="Project"
        description="The board of this project only. Other projects stay out of reach."
      >
        <Autocomplete
          name="projectKey"
          value={values.projectKey}
          placeholder="Choose a project"
          loadOptions={query => ui.listProjects(query, values.host ?? undefined)}
          onChange={projectKey => setValues({ projectKey })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<InferOpsProjectConfiguratorRpc, InferOpsProjectConfiguratorValues>;
