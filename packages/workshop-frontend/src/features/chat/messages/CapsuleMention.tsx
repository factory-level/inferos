import type { CapsuleSpecifier } from "@gadgets/workshop-shared/api";
import styles from "../../../ChatInterface.module.css";
import { useAuthenticatedApi } from "../../../AuthContext";
import { useVendorBranding } from "../../../useVendorBranding";
import { safeExternalUrl } from "../../../utils/safeExternalUrl";

export function CapsuleMention({ capsule }: { capsule: CapsuleSpecifier }) {
  const { authenticatedApi } = useAuthenticatedApi();
  const vendorBranding = useVendorBranding(authenticatedApi);
  const logo = capsule.vendorId ? vendorBranding.get(capsule.vendorId)?.logoUrl : undefined;
  const safeUrl = safeExternalUrl(capsule.description.url);
  const body = (
    <>
      {logo && <img src={logo} alt="" className={styles.capsuleMentionLogo} />}
      {capsule.description.title}
    </>
  );
  return safeUrl ? (
    <a
      href={safeUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.capsuleMention}
    >
      {body}
    </a>
  ) : (
    <span className={styles.capsuleMention}>{body}</span>
  );
}
