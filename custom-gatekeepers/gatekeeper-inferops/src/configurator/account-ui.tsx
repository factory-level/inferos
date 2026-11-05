import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  InferOpsProjectConfiguratorRpc,
  InferOpsProjectConfiguratorValues,
} from "./project-configurator-types";

// The InferOps account picker: the organization only, building `inferops://<organization>/account`
// (or `inferops://demo.local/account` for demo data). There is no workspace or project to choose:
// each board and Wiki is named when it is opened, and checked against the person's own workspaces
// then. Duplicates the grammar in ../resources.ts on purpose: build-gatekeeper-configurator.ts
// transpiles this file on its own, so it cannot import runtime helpers. __tests__/resources.test.ts
// keeps the copies in step, and the gatekeeper validates whatever URL this builds.
const ACCOUNT_URL = /^inferops:\/\/([^/?#]+)\/account\/?$/;

export default {
  initial: { tenant: null },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const tenant = ACCOUNT_URL.exec(resourceUrl.trim())?.[1];
    return tenant ? { tenant } : {};
  },

  async resourceUrl({ values, ui }) {
    const tenant = values.tenant?.trim().toLowerCase() || await ui.defaultHost();
    if (!tenant) throw new Error("Enter your organization.");
    return `inferops://${tenant}/account`;
  },

  render({ values, setValues }) {
    return <Section>
      <Field
        label="Organization"
        description={"Your InferLab organization's short name, as in inferops://<organization>/account. " +
          "One connection opens every InferOps board and InferMind Wiki you can open there, with your " +
          "own access, and changes still wait for your approval. Leave empty for demo data."}
        optional
      >
        <TextInput
          name="tenant"
          value={values.tenant}
          placeholder="acme"
          optional
          onChange={tenant => setValues({ tenant })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<InferOpsProjectConfiguratorRpc, InferOpsProjectConfiguratorValues>;
