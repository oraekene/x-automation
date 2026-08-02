# Snapshot projects are one-time copies that never sync upstream

The Base template framework has two modes. Profile distributions stay current with upstream hermes-agent by design. Snapshot projects deliberately do the opposite: the project is built inside a one-time copy of the Repo pinned at a single Release tag, and the copy is never synced, so the project diverges permanently from that point. Tracking 19k+ upstream commits per project was rejected as a cost; "fork" is the wrong word for this mode because a git fork implies ongoing upstream tracking.

Status: accepted
