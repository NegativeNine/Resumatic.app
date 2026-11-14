import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ConceptCoveragePanel } from "../../src/web/components/ConceptCoverage";
import type { ConceptSelection } from "../../src/shared/concept-tailoring";

it("shows exact requirements, supporting words and unknown checks without calling them absent experience", () => {
  const coverage: ConceptSelection = { method: "concept-evidence/1", taxonomyVersion: "test", model: "test", requirements: [], coverage: [
    { requirement: "Python services", status: "supported", factIds: ["f"], concepts: [{ id: "python", label: "Python", factIds: ["f"] }], conceptStatus: "tagged" },
    { requirement: "5 years of Kubernetes", status: "unknown", factIds: [], concepts: [], conceptStatus: "unknown" },
    { requirement: "Budget management", status: "not_evidenced", factIds: [], concepts: [], conceptStatus: "tagged" },
  ] };
  render(<ConceptCoveragePanel coverage={coverage} facts={{ f: { text: "Built services in Python" } }} />);
  expect(screen.getByText("Built services in Python")).toBeInTheDocument();
  expect(screen.getByText("Matched experience: Python")).toBeInTheDocument();
  expect(screen.getByText("Not established by this check")).toBeInTheDocument();
  expect(screen.getByText("No supporting fact found in this check")).toBeInTheDocument();
  expect(screen.queryByText("Not in your record")).not.toBeInTheDocument();
});
