import {
  Autocomplete, Field, h, Section, TextInput, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  InferOpsProjectConfiguratorRpc,
  InferOpsProjectConfiguratorValues,
} from "./project-configurator-types";

// The workspace-members picker: organization and workspace only, building
// `inferops://<organization>.<workspace>/portal/members`. Duplicates the grammar in ../resources.ts
// on purpose: build-gatekeeper-configurator.ts transpiles this file on its own, so it cannot import
// runtime helpers. __tests__/resources.test.ts keeps the copies in step. The account lists only the
// person's InferOps workspaces here, and the gatekeeper validates whatever URL this builds.
const MEMBERS_URL = /^inferops:\/\/([^/?#.]+)\.([^/?#.]+)\/portal\/members\/?$/;

/** `<tenant>.<workspace>` from the form, or null until both are given. */
function hostOf(values: InferOpsProjectConfiguratorValues): string | null {
  const tenant = values.tenant?.trim().toLowerCase();
  const workspace = values.workspace?.trim();
  return tenant && workspace ? `${tenant}.${workspace}` : null;
}

export default {
  initial: { tenant: null, workspace: null },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const match = MEMBERS_URL.exec(resourceUrl.trim());
    return match ? { tenant: match[1]!, workspace: match[2]! } : {};
  },

  async resourceUrl({ values, ui }) {
    const host = hostOf(values) ?? await ui.defaultHost();
    if (!host) throw new Error("Enter your organization and choose an InferOps workspace.");
    return `inferops://${host}/portal/members`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="Organization"
        description={"Your InferLab organization's short name, as in " +
          "inferops://<organization>.<workspace>/…. It only labels the address: your workspace " +
          "membership decides what you can open. Leave empty for demo data."}
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
      <Field
        label="Workspace"
        description={"One of your InferOps workspaces. Its members are read with your own InferOps " +
          "access, without email addresses, and only you can see them. Leave empty for demo data."}
        optional
      >
        <Autocomplete
          name="workspace"
          value={values.workspace}
          placeholder="Choose a workspace"
          optional
          loadOptions={() => ui.listWorkspaces()}
          onChange={workspace => setValues({ workspace })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<InferOpsProjectConfiguratorRpc, InferOpsProjectConfiguratorValues>;
