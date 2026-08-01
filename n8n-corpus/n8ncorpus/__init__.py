"""n8n corpus crawler: pure indexing + manifest layer.

The functions in this package are the pre-agreed testing seam: everything
that decides, parses, or shapes data is pure and unit-tested. The I/O shell
(git, HTTP, filesystem writes) lives in :mod:`n8ncorpus.gitops` and
:mod:`n8ncorpus.crawler`, and is exercised only via fixture tests.
"""
