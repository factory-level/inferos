import type { PhosphorIcon } from "./toolCallLabels";

export function WorkIcon({ Icon }: { Icon: PhosphorIcon }) {
  return <Icon size={15} className="text-kumo-inactive" />;
}
