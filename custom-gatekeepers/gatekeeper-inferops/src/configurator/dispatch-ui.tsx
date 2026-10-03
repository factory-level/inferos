import {
  Autocomplete, Field, h, Section, TextInput, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  InferOpsProjectConfiguratorRpc,
  InferOpsProjectConfiguratorValues,
} from "./project-configurator-types";

// The coding-dispatch picker: the project-board picker (project-ui.tsx) with the dispatch path.
// Duplicates the grammar in ../resources.ts on purpose: build-gatekeeper-configurator.ts transpiles
// this file on its own, so it cannot import runtime helpers or share code with project-ui.tsx.
// __tests__/resources.test.ts keeps the copies in step. The gatekeeper validates whatever URL this
// builds, and binds it only while the deployment has coding dispatch on.
const DISPATCH_URL = /^inferops:\/\/([^/?#.]+)\.([^/?#.]+)\/project\/dispatch\/([^/?#]+)\/?$/;

/** `<tenant>.<workspace>` from the form, or null until both are given. */
function hostOf(values: InferOpsProjectConfiguratorValues): string | null {
  const tenant = values.tenant?.trim().toLowerCase();
  const workspace = values.workspace?.trim();
  return tenant && workspace ? `${tenant}.${workspace}` : null;
}

export default {
  initial: { tenant: null, workspace: null, projectKey: null },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const match = DISPATCH_URL.exec(resourceUrl.trim());
    return match ? { tenant: match[1]!, workspace: match[2]!, projectKey: match[3]! } : {};
  },

  isReady({ values }) {
    return typeof values.projectKey === "string" && values.projectKey.length > 0;
  },

  async resourceUrl({ values, ui }) {
    const host = hostOf(values) ?? await ui.defaultHost();
    if (!host) throw new Error("Enter your organization and choose a workspace.");
    return `inferops://${host}/project/dispatch/${values.projectKey}`;
  },

  render({ values, setValues, clearFields, ui }) {
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
        description="One of your InferOps workspaces. Leave empty for demo data."
        optional
      >
        <Autocomplete
          name="workspace"
          value={values.workspace}
          placeholder="Choose a workspace"
          optional
          loadOptions={() => ui.listWorkspaces()}
          onChange={workspace => {
            setValues({ workspace, projectKey: null });
            clearFields("projectKey");
          }}
        />
      </Field>
      <Field
        label="Project"
        description={"Coding dispatch for this project's issues only. Other projects stay out of " +
          "reach, and your own InferOps dispatch permission still applies."}
      >
        <Autocomplete
          name="projectKey"
          value={values.projectKey}
          placeholder="Choose a project"
          loadOptions={async query => ui.listProjects(query, hostOf(values) ?? await ui.defaultHost() ?? "")}
          onChange={projectKey => setValues({ projectKey })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<InferOpsProjectConfiguratorRpc, InferOpsProjectConfiguratorValues>;
