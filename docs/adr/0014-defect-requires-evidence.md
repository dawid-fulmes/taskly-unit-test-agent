# ADR 0014: A suspected defect requires verifiable evidence

Status: Accepted

## Context

A suspected defect is the only outcome that turns `test-agent/verified` red (ADR 0007). If it rested on the model's claim alone, it would violate ADR 0002: a hallucination could block a good pull request, and a prompt injection could produce red checks at will.

## Options

1. Trust the model's claim that the code contradicts the spec.
2. Require evidence that deterministic code can check, and leave only the semantic judgement to a human.

## Decision

Option 2. A defect without evidence does not count.

The agent must provide:

- an **evidence test** that encodes the expected behaviour, and
- a **source citation**: a JSON pointer into `backend/openapi.json`, or an exact quote from the pull request description.

The verifier independently checks that:

- the evidence test passes the same patch gates as any other test (ADR 0008),
- it fails on the head **3 times in a row**, and every failure is an assertion failure, not an import, syntax or runtime error such as `TypeError`,
- the citation exists: the JSON pointer resolves in the OpenAPI document, or the quote appears verbatim in the pull request description.

If any check fails, the defect claim is rejected and does not affect the check conclusion.

Whether the test correctly interprets the spec cannot be decided deterministically, and that is acceptable. The red check shows the failing test and the citation side by side so a human can judge it in seconds. If it is a hallucination, a `test-agent:dismiss` label moves the check to neutral. The label only takes effect when the person who added it has write permission and is not the pull request author; otherwise it is ignored and the comment says why.

The evidence test is not committed (it would break CI). It appears in the comment inside a collapsed section. All other tests from the same run are committed normally if they passed verification.

## Why

- Every input to the red status is checkable except the one judgement that only a human can make, and that judgement is made cheap.
- A prompt injection in the pull request description can at most block that same pull request, so an attacker can only hurt themselves.
- Requiring three consecutive failures rules out flaky evidence.
