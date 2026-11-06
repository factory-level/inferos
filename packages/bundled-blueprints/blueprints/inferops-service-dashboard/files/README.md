# Service dashboard

Connect one live InferOps service project as `project`. The dashboard composes three widgets:
service jobs with their permitted customer/site/contact relations, status counts, and recent
activity. Each refresh reads the published version-1 query through the connection's current
identity. Page controls traverse cursor results; failed reads are not shown as empty data.

A comment is a pending governed action. It carries the head read with the selected job, is
applied only through the Workshop action review, and must be refreshed after approval. A stale
head or revoked grant is refused by InferOps. This gadget stores no business records and offers
no export. Joined observations are private to the connected person.

The demo connector deliberately refuses these queries. Use the synthetic FAC-172 company data
plane for live proof; a mock UI run is not provider or performance evidence.
