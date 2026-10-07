import {
  Autocomplete, Field, h, Section, TextInput, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  InferOpsProjectConfiguratorRpc,
  InferOpsProjectConfiguratorValues,
} from "./project-configurator-types";

// The custom table picker: organization, workspace and table, building
// `inferops://<organization>.<workspace>/object/table/<tableId>`. Duplicates the grammar in
// ../resources.ts on purpose: build-gatekeeper-configurator.ts transpiles this file on its own, so
// it cannot import runtime helpers. __tests__/resources.test.ts keeps the copies in step. The
// gatekeeper validates whatever URL this builds, and InferOps checks it again on every read.
const TABLE_URL = /^inferops:\/\/([^/?#.]+)\.([^/?#.]+)\/object\/table\/([^/?#]+)\/?$/;

/** `<tenant>.<workspace>` from the form, or null until both are given. */
function hostOf(values: InferOpsProjectConfiguratorValues): string | null {
  const tenant = values.tenant?.trim().toLowerCase();
  const workspace = values.workspace?.trim();
  return tenant && workspace ? `${tenant}.${workspace}` : null;
}

export default {
  initial: { tenant: null, workspace: null, tableId: null },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const match = TABLE_URL.exec(resourceUrl.trim());
    return match ? { tenant: match[1]!, workspace: match[2]!, tableId: match[3]! } : {};
  },

  async resourceUrl({ values, ui }) {
    const host = hostOf(values) ?? await ui.defaultHost();
    const tableId = values.tableId?.trim().toLowerCase();
    if (!host || !tableId) throw new Error("Enter your organization, then choose a workspace and a table.");
    return `inferops://${host}/object/table/${tableId}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="Organization"
        description={"Your InferLab organization's short name, as in " +
          "inferops://<organization>.<workspace>/…. InferOps checks it, with the workspace, on " +
          "every read. Leave empty for demo data."}
        optional
      >
        <TextInput
          name="tenant"
          value={values.tenant}
          placeholder="acme"
          optional
          onChange={tenant => setValues({ tenant, tableId: null })}
        />
      </Field>
      <Field
        label="Workspace"
        description={"One of your InferOps workspaces. Leave empty for demo data."}
        optional
      >
        <Autocomplete
          name="workspace"
          value={values.workspace}
          placeholder="Choose a workspace"
          optional
          loadOptions={() => ui.listWorkspaces()}
          onChange={workspace => setValues({ workspace, tableId: null })}
        />
      </Field>
      <Field
        label="Table"
        description={"The custom table to read with your own InferOps access. Columns its owner " +
          "marked personal are left out. This connection is never shared with collaborators."}
      >
        <Autocomplete
          name="tableId"
          value={values.tableId}
          placeholder="Choose a table"
          loadOptions={async query => ui.listTables(query, hostOf(values) ?? await ui.defaultHost() ?? "")}
          onChange={tableId => setValues({ tableId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<InferOpsProjectConfiguratorRpc, InferOpsProjectConfiguratorValues>;
