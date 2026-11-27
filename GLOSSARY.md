# H-Tosho

H-Tosho manages Kavita manga and doujinshi libraries: matching series to metadata sources, protecting user-curated metadata, downloading galleries, and merging archives into Kavita series.

## Language

**Protected Merge**:
An operation that combines local archives and queued downloads into a single Kavita series folder while preserving every affected series' **Field Policy** and blocking unapproved title changes.
_Avoid_: Merge protection, series merge job, merge group

**Field Policy**:
The set of metadata fields a user has locked on a Kavita series so automatic syncs, restores, and **Protected Merges** cannot overwrite them without explicit approval.
_Avoid_: Protection settings, field locks

**Move Intent**:
A durable, hash-verified record of a single archive move written before moving the file so a **Protected Merge** can safely recover after a crash or interruption.
_Avoid_: Pending publication, move checkpoint

**Retry Family**:
A **Protected Merge** and all of its subsequent retries, linked together so completing or recovering any attempt updates the retained evidence across every sibling attempt.
_Avoid_: Root job group, retry siblings
