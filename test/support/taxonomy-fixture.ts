// Written by scripts/taxonomy/fixture.mjs from test/fixtures/taxonomy. Do not edit by hand:
// change the CSV files and run the script. The records are synthetic, not ESCO or O*NET data.
import type { TaxonomyRecords } from "../../src/taxonomy/store";

export const TAXONOMY_FIXTURE: TaxonomyRecords = {
  "info": {
    "format": 1,
    "version": "esco-0.0.1+onet-0.0+3191aa55",
    "contentHash": "3191aa557f27852e085394f81e9d7677841fc9f0f1bbffd696fb8f256edc21ce",
    "sources": [
      {
        "id": "esco",
        "name": "ESCO classification",
        "version": "0.0.1"
      },
      {
        "id": "onet",
        "name": "O*NET 0.0 Database",
        "version": "0.0"
      },
      {
        "id": "esco-onet-crosswalk",
        "name": "O*NET - ESCO crosswalk (occupations)",
        "version": "test"
      }
    ]
  },
  "concepts": [
    {
      "id": "esco:isced-f:061",
      "kind": "skill-group",
      "scheme": "esco",
      "code": "061",
      "label": "information and communication technologies",
      "description": null,
      "meta": {}
    },
    {
      "id": "esco:isco:C251",
      "kind": "occupation-group",
      "scheme": "esco",
      "code": "251",
      "label": "Software and applications developers and analysts",
      "description": null,
      "meta": {}
    },
    {
      "id": "esco:isco:C2512",
      "kind": "occupation-group",
      "scheme": "esco",
      "code": "2512",
      "label": "Software developers",
      "description": null,
      "meta": {}
    },
    {
      "id": "esco:occupation:00000000-0000-4000-8000-000000000001",
      "kind": "occupation",
      "scheme": "esco",
      "code": "2512.4",
      "label": "software developer",
      "description": "Software developers implement or program software systems.",
      "meta": {
        "iscoGroup": "2512"
      }
    },
    {
      "id": "esco:occupation:00000000-0000-4000-8000-000000000002",
      "kind": "occupation",
      "scheme": "esco",
      "code": "1330.1",
      "label": "ICT project manager",
      "description": "ICT project managers schedule, control and direct resources.",
      "meta": {
        "iscoGroup": "1330"
      }
    },
    {
      "id": "esco:occupation:00000000-0000-4000-8000-000000000003",
      "kind": "occupation",
      "scheme": "esco",
      "code": "2411.1.3",
      "label": "budget analyst",
      "description": "Budget analysts monitor the spending of institutions.",
      "meta": {
        "iscoGroup": "2411"
      }
    },
    {
      "id": "esco:skill:00000000-0000-4000-8000-000000000001",
      "kind": "skill",
      "scheme": "esco",
      "code": null,
      "label": "manage budgets",
      "description": "Plan, monitor and report on the budget. Synthetic test row.",
      "meta": {
        "reuse": "cross-sector"
      }
    },
    {
      "id": "esco:skill:00000000-0000-4000-8000-000000000002",
      "kind": "skill",
      "scheme": "esco",
      "code": null,
      "label": "lead a team",
      "description": "Lead, supervise and motivate a group of people.",
      "meta": {
        "collections": [
          "transversal"
        ],
        "reuse": "transversal"
      }
    },
    {
      "id": "esco:skill:00000000-0000-4000-8000-000000000003",
      "kind": "knowledge",
      "scheme": "esco",
      "code": null,
      "label": "Python (computer programming)",
      "description": "The techniques and principles of software development in Python.",
      "meta": {
        "collections": [
          "digital"
        ],
        "reuse": "sector-specific"
      }
    },
    {
      "id": "esco:skill:00000000-0000-4000-8000-000000000004",
      "kind": "knowledge",
      "scheme": "esco",
      "code": null,
      "label": "container orchestration",
      "description": "Tools that deploy, scale and run containers. It's a synthetic row, with a comma.",
      "meta": {
        "collections": [
          "digital"
        ],
        "reuse": "sector-specific"
      }
    },
    {
      "id": "esco:skill:00000000-0000-4000-8000-000000000005",
      "kind": "skill",
      "scheme": "esco",
      "code": null,
      "label": "migrate existing data",
      "description": "Apply migration and conversion methods for existing data.",
      "meta": {
        "reuse": "cross-sector"
      }
    },
    {
      "id": "esco:skill:00000000-0000-4000-8000-000000000006",
      "kind": "knowledge",
      "scheme": "esco",
      "code": null,
      "label": "Go (computer programming)",
      "description": "The techniques and principles of software development in Go.",
      "meta": {
        "reuse": "sector-specific"
      }
    },
    {
      "id": "esco:skill:00000000-0000-4000-8000-000000000007",
      "kind": "skill",
      "scheme": "esco",
      "code": null,
      "label": "use spreadsheets software",
      "description": "Use software tools to create and edit tabular data.",
      "meta": {
        "reuse": "cross-sector"
      }
    },
    {
      "id": "esco:skill:00000000-0000-4000-8000-000000000008",
      "kind": "knowledge",
      "scheme": "esco",
      "code": null,
      "label": "SQL",
      "description": "The query language \"SQL\".",
      "meta": {
        "collections": [
          "digital"
        ],
        "reuse": "cross-sector"
      }
    },
    {
      "id": "esco:skill:S1",
      "kind": "skill-group",
      "scheme": "esco",
      "code": "S1",
      "label": "management skills",
      "description": null,
      "meta": {}
    },
    {
      "id": "esco:skill:S1.1",
      "kind": "skill-group",
      "scheme": "esco",
      "code": "S1.1",
      "label": "allocating and controlling resources",
      "description": null,
      "meta": {}
    },
    {
      "id": "onet:activity:4.A.3.b.1",
      "kind": "activity",
      "scheme": "onet",
      "code": "4.A.3.b.1",
      "label": "Working with Computers",
      "description": null,
      "meta": {
        "level": "general"
      }
    },
    {
      "id": "onet:activity:4.A.3.b.1.I01",
      "kind": "activity",
      "scheme": "onet",
      "code": "4.A.3.b.1.I01",
      "label": "Program computer systems or production equipment.",
      "description": null,
      "meta": {
        "level": "intermediate"
      }
    },
    {
      "id": "onet:activity:4.A.3.b.1.I01.D01",
      "kind": "activity",
      "scheme": "onet",
      "code": "4.A.3.b.1.I01.D01",
      "label": "Write computer programming code.",
      "description": null,
      "meta": {
        "level": "detailed"
      }
    },
    {
      "id": "onet:activity:4.A.3.b.1.I01.D02",
      "kind": "activity",
      "scheme": "onet",
      "code": "4.A.3.b.1.I01.D02",
      "label": "Migrate software systems to new platforms.",
      "description": null,
      "meta": {
        "level": "detailed"
      }
    },
    {
      "id": "onet:activity:4.A.4.b.4",
      "kind": "activity",
      "scheme": "onet",
      "code": "4.A.4.b.4",
      "label": "Guiding, Directing, and Motivating Subordinates",
      "description": null,
      "meta": {
        "level": "general"
      }
    },
    {
      "id": "onet:activity:4.A.4.b.4.I01",
      "kind": "activity",
      "scheme": "onet",
      "code": "4.A.4.b.4.I01",
      "label": "Direct organizational operations, projects, or services.",
      "description": null,
      "meta": {
        "level": "intermediate"
      }
    },
    {
      "id": "onet:activity:4.A.4.b.4.I01.D01",
      "kind": "activity",
      "scheme": "onet",
      "code": "4.A.4.b.4.I01.D01",
      "label": "Manage project teams.",
      "description": null,
      "meta": {
        "level": "detailed"
      }
    },
    {
      "id": "onet:activity:4.A.4.c.3",
      "kind": "activity",
      "scheme": "onet",
      "code": "4.A.4.c.3",
      "label": "Monitoring and Controlling Resources",
      "description": null,
      "meta": {
        "level": "general"
      }
    },
    {
      "id": "onet:activity:4.A.4.c.3.I01",
      "kind": "activity",
      "scheme": "onet",
      "code": "4.A.4.c.3.I01",
      "label": "Manage budgets or finances.",
      "description": null,
      "meta": {
        "level": "intermediate"
      }
    },
    {
      "id": "onet:activity:4.A.4.c.3.I01.D01",
      "kind": "activity",
      "scheme": "onet",
      "code": "4.A.4.c.3.I01.D01",
      "label": "Prepare operational budgets.",
      "description": null,
      "meta": {
        "level": "detailed"
      }
    },
    {
      "id": "onet:occ:99-1001.00",
      "kind": "occupation",
      "scheme": "onet",
      "code": "99-1001.00",
      "label": "Example Software Developers",
      "description": "Research, design, and develop computer software. Synthetic test row.",
      "meta": {}
    },
    {
      "id": "onet:occ:99-1002.00",
      "kind": "occupation",
      "scheme": "onet",
      "code": "99-1002.00",
      "label": "Example Project Management Specialists",
      "description": "Analyze and coordinate the schedule, timeline and budget of a project. Synthetic test row.",
      "meta": {}
    },
    {
      "id": "onet:occ:99-1003.00",
      "kind": "occupation",
      "scheme": "onet",
      "code": "99-1003.00",
      "label": "Example Budget Analysts",
      "description": "Examine budget estimates for completeness and accuracy. Synthetic test row.",
      "meta": {}
    },
    {
      "id": "onet:task:9001",
      "kind": "task",
      "scheme": "onet",
      "code": "9001",
      "label": "Write and test code for new software features.",
      "description": null,
      "meta": {
        "taskType": "Core"
      }
    },
    {
      "id": "onet:task:9002",
      "kind": "task",
      "scheme": "onet",
      "code": "9002",
      "label": "Move services from one hosting platform to another.",
      "description": null,
      "meta": {
        "taskType": "Supplemental"
      }
    },
    {
      "id": "onet:task:9003",
      "kind": "task",
      "scheme": "onet",
      "code": "9003",
      "label": "Lead project teams and coordinate their work.",
      "description": null,
      "meta": {
        "taskType": "Core"
      }
    },
    {
      "id": "onet:task:9004",
      "kind": "task",
      "scheme": "onet",
      "code": "9004",
      "label": "Prepare and monitor departmental budgets.",
      "description": null,
      "meta": {
        "taskType": "Core"
      }
    },
    {
      "id": "onet:task:9005",
      "kind": "task",
      "scheme": "onet",
      "code": "9005",
      "label": "Track project spending against the approved budget.",
      "description": null,
      "meta": {}
    },
    {
      "id": "onet:tool:amazon-web-services-aws-software",
      "kind": "tool",
      "scheme": "onet",
      "code": null,
      "label": "Amazon Web Services AWS software",
      "description": null,
      "meta": {
        "hot": true
      }
    },
    {
      "id": "onet:tool:c++",
      "kind": "tool",
      "scheme": "onet",
      "code": null,
      "label": "C++",
      "description": null,
      "meta": {}
    },
    {
      "id": "onet:tool:go",
      "kind": "tool",
      "scheme": "onet",
      "code": null,
      "label": "Go",
      "description": null,
      "meta": {}
    },
    {
      "id": "onet:tool:kubernetes",
      "kind": "tool",
      "scheme": "onet",
      "code": null,
      "label": "Kubernetes",
      "description": null,
      "meta": {
        "hot": true
      }
    },
    {
      "id": "onet:tool:microsoft-excel",
      "kind": "tool",
      "scheme": "onet",
      "code": null,
      "label": "Microsoft Excel",
      "description": null,
      "meta": {
        "hot": true
      }
    },
    {
      "id": "onet:tool:python",
      "kind": "tool",
      "scheme": "onet",
      "code": null,
      "label": "Python",
      "description": null,
      "meta": {
        "hot": true
      }
    },
    {
      "id": "onet:toolcat:5.A.1.01",
      "kind": "tool-category",
      "scheme": "onet",
      "code": "5.A.1.01",
      "label": "Object or component oriented development software",
      "description": null,
      "meta": {}
    },
    {
      "id": "onet:toolcat:5.A.1.02",
      "kind": "tool-category",
      "scheme": "onet",
      "code": "5.A.1.02",
      "label": "Container orchestration software",
      "description": null,
      "meta": {}
    },
    {
      "id": "onet:toolcat:5.A.2.01",
      "kind": "tool-category",
      "scheme": "onet",
      "code": "5.A.2.01",
      "label": "Spreadsheet software",
      "description": null,
      "meta": {}
    }
  ],
  "labels": [
    {
      "conceptId": "esco:skill:S1.1",
      "kind": "skill-group",
      "type": "preferred",
      "text": "allocating and controlling resources",
      "norm": "allocating and controlling resources"
    },
    {
      "conceptId": "onet:tool:amazon-web-services-aws-software",
      "kind": "tool",
      "type": "derived",
      "text": "Amazon Web Services AWS",
      "norm": "amazon web services aws"
    },
    {
      "conceptId": "onet:tool:amazon-web-services-aws-software",
      "kind": "tool",
      "type": "preferred",
      "text": "Amazon Web Services AWS software",
      "norm": "amazon web services aws software"
    },
    {
      "conceptId": "esco:occupation:00000000-0000-4000-8000-000000000003",
      "kind": "occupation",
      "type": "preferred",
      "text": "budget analyst",
      "norm": "budget analyst"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000001",
      "kind": "skill",
      "type": "alternative",
      "text": "budget management",
      "norm": "budget management"
    },
    {
      "conceptId": "onet:tool:c++",
      "kind": "tool",
      "type": "preferred",
      "text": "C++",
      "norm": "c++"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000004",
      "kind": "knowledge",
      "type": "preferred",
      "text": "container orchestration",
      "norm": "container orchestration"
    },
    {
      "conceptId": "onet:toolcat:5.A.1.02",
      "kind": "tool-category",
      "type": "preferred",
      "text": "Container orchestration software",
      "norm": "container orchestration software"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000005",
      "kind": "skill",
      "type": "alternative",
      "text": "data migration",
      "norm": "data migration"
    },
    {
      "conceptId": "onet:activity:4.A.4.b.4.I01",
      "kind": "activity",
      "type": "preferred",
      "text": "Direct organizational operations, projects, or services.",
      "norm": "direct organizational operations projects or services"
    },
    {
      "conceptId": "onet:occ:99-1003.00",
      "kind": "occupation",
      "type": "preferred",
      "text": "Example Budget Analysts",
      "norm": "example budget analysts"
    },
    {
      "conceptId": "onet:occ:99-1002.00",
      "kind": "occupation",
      "type": "preferred",
      "text": "Example Project Management Specialists",
      "norm": "example project management specialists"
    },
    {
      "conceptId": "onet:occ:99-1001.00",
      "kind": "occupation",
      "type": "preferred",
      "text": "Example Software Developers",
      "norm": "example software developers"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000006",
      "kind": "knowledge",
      "type": "derived",
      "text": "Go",
      "norm": "go"
    },
    {
      "conceptId": "onet:tool:go",
      "kind": "tool",
      "type": "preferred",
      "text": "Go",
      "norm": "go"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000006",
      "kind": "knowledge",
      "type": "preferred",
      "text": "Go (computer programming)",
      "norm": "go computer programming"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000006",
      "kind": "knowledge",
      "type": "alternative",
      "text": "Golang",
      "norm": "golang"
    },
    {
      "conceptId": "onet:activity:4.A.4.b.4",
      "kind": "activity",
      "type": "preferred",
      "text": "Guiding, Directing, and Motivating Subordinates",
      "norm": "guiding directing and motivating subordinates"
    },
    {
      "conceptId": "esco:occupation:00000000-0000-4000-8000-000000000002",
      "kind": "occupation",
      "type": "preferred",
      "text": "ICT project manager",
      "norm": "ict project manager"
    },
    {
      "conceptId": "esco:isced-f:061",
      "kind": "skill-group",
      "type": "preferred",
      "text": "information and communication technologies",
      "norm": "information and communication technologies"
    },
    {
      "conceptId": "esco:occupation:00000000-0000-4000-8000-000000000002",
      "kind": "occupation",
      "type": "alternative",
      "text": "IT project manager",
      "norm": "it project manager"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000004",
      "kind": "knowledge",
      "type": "alternative",
      "text": "K8s",
      "norm": "k8s"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000004",
      "kind": "knowledge",
      "type": "alternative",
      "text": "Kubernetes",
      "norm": "kubernetes"
    },
    {
      "conceptId": "onet:tool:kubernetes",
      "kind": "tool",
      "type": "preferred",
      "text": "Kubernetes",
      "norm": "kubernetes"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000002",
      "kind": "skill",
      "type": "preferred",
      "text": "lead a team",
      "norm": "lead a team"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000002",
      "kind": "skill",
      "type": "alternative",
      "text": "lead teams",
      "norm": "lead teams"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000001",
      "kind": "skill",
      "type": "alternative",
      "text": "manage a budget",
      "norm": "manage a budget"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000001",
      "kind": "skill",
      "type": "preferred",
      "text": "manage budgets",
      "norm": "manage budgets"
    },
    {
      "conceptId": "onet:activity:4.A.4.c.3.I01",
      "kind": "activity",
      "type": "preferred",
      "text": "Manage budgets or finances.",
      "norm": "manage budgets or finances"
    },
    {
      "conceptId": "onet:activity:4.A.4.b.4.I01.D01",
      "kind": "activity",
      "type": "preferred",
      "text": "Manage project teams.",
      "norm": "manage project teams"
    },
    {
      "conceptId": "esco:skill:S1",
      "kind": "skill-group",
      "type": "preferred",
      "text": "management skills",
      "norm": "management skills"
    },
    {
      "conceptId": "onet:tool:microsoft-excel",
      "kind": "tool",
      "type": "preferred",
      "text": "Microsoft Excel",
      "norm": "microsoft excel"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000005",
      "kind": "skill",
      "type": "preferred",
      "text": "migrate existing data",
      "norm": "migrate existing data"
    },
    {
      "conceptId": "onet:activity:4.A.3.b.1.I01.D02",
      "kind": "activity",
      "type": "preferred",
      "text": "Migrate software systems to new platforms.",
      "norm": "migrate software systems to new platforms"
    },
    {
      "conceptId": "onet:activity:4.A.4.c.3",
      "kind": "activity",
      "type": "preferred",
      "text": "Monitoring and Controlling Resources",
      "norm": "monitoring and controlling resources"
    },
    {
      "conceptId": "onet:toolcat:5.A.1.01",
      "kind": "tool-category",
      "type": "preferred",
      "text": "Object or component oriented development software",
      "norm": "object or component oriented development software"
    },
    {
      "conceptId": "onet:activity:4.A.4.c.3.I01.D01",
      "kind": "activity",
      "type": "preferred",
      "text": "Prepare operational budgets.",
      "norm": "prepare operational budgets"
    },
    {
      "conceptId": "onet:activity:4.A.3.b.1.I01",
      "kind": "activity",
      "type": "preferred",
      "text": "Program computer systems or production equipment.",
      "norm": "program computer systems or production equipment"
    },
    {
      "conceptId": "esco:occupation:00000000-0000-4000-8000-000000000001",
      "kind": "occupation",
      "type": "alternative",
      "text": "programmer",
      "norm": "programmer"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000003",
      "kind": "knowledge",
      "type": "alternative",
      "text": "Python",
      "norm": "python"
    },
    {
      "conceptId": "onet:tool:python",
      "kind": "tool",
      "type": "preferred",
      "text": "Python",
      "norm": "python"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000003",
      "kind": "knowledge",
      "type": "preferred",
      "text": "Python (computer programming)",
      "norm": "python computer programming"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000003",
      "kind": "knowledge",
      "type": "hidden",
      "text": "python3",
      "norm": "python3"
    },
    {
      "conceptId": "onet:occ:99-1001.00",
      "kind": "occupation",
      "type": "alternative",
      "text": "Senior Backend Engineer",
      "norm": "senior backend engineer"
    },
    {
      "conceptId": "esco:isco:C251",
      "kind": "occupation-group",
      "type": "preferred",
      "text": "Software and applications developers and analysts",
      "norm": "software and applications developers and analysts"
    },
    {
      "conceptId": "esco:occupation:00000000-0000-4000-8000-000000000001",
      "kind": "occupation",
      "type": "preferred",
      "text": "software developer",
      "norm": "software developer"
    },
    {
      "conceptId": "esco:isco:C2512",
      "kind": "occupation-group",
      "type": "preferred",
      "text": "Software developers",
      "norm": "software developers"
    },
    {
      "conceptId": "esco:occupation:00000000-0000-4000-8000-000000000001",
      "kind": "occupation",
      "type": "alternative",
      "text": "software engineer",
      "norm": "software engineer"
    },
    {
      "conceptId": "onet:occ:99-1001.00",
      "kind": "occupation",
      "type": "alternative",
      "text": "Software Engineer",
      "norm": "software engineer"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000007",
      "kind": "skill",
      "type": "alternative",
      "text": "spreadsheet software",
      "norm": "spreadsheet software"
    },
    {
      "conceptId": "onet:toolcat:5.A.2.01",
      "kind": "tool-category",
      "type": "preferred",
      "text": "Spreadsheet software",
      "norm": "spreadsheet software"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000008",
      "kind": "knowledge",
      "type": "preferred",
      "text": "SQL",
      "norm": "sql"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000002",
      "kind": "skill",
      "type": "alternative",
      "text": "team leadership",
      "norm": "team leadership"
    },
    {
      "conceptId": "onet:occ:99-1002.00",
      "kind": "occupation",
      "type": "alternative",
      "text": "Tech PM",
      "norm": "tech pm"
    },
    {
      "conceptId": "onet:occ:99-1002.00",
      "kind": "occupation",
      "type": "alternative",
      "text": "Technical Project Manager",
      "norm": "technical project manager"
    },
    {
      "conceptId": "esco:skill:00000000-0000-4000-8000-000000000007",
      "kind": "skill",
      "type": "preferred",
      "text": "use spreadsheets software",
      "norm": "use spreadsheets software"
    },
    {
      "conceptId": "onet:activity:4.A.3.b.1",
      "kind": "activity",
      "type": "preferred",
      "text": "Working with Computers",
      "norm": "working with computers"
    },
    {
      "conceptId": "onet:activity:4.A.3.b.1.I01.D01",
      "kind": "activity",
      "type": "preferred",
      "text": "Write computer programming code.",
      "norm": "write computer programming code"
    }
  ],
  "edges": [
    {
      "src": "esco:isco:C2512",
      "rel": "broader",
      "dst": "esco:isco:C251",
      "meta": null
    },
    {
      "src": "esco:occupation:00000000-0000-4000-8000-000000000001",
      "rel": "broader",
      "dst": "esco:isco:C2512",
      "meta": null
    },
    {
      "src": "esco:occupation:00000000-0000-4000-8000-000000000001",
      "rel": "essential",
      "dst": "esco:skill:00000000-0000-4000-8000-000000000003",
      "meta": null
    },
    {
      "src": "esco:occupation:00000000-0000-4000-8000-000000000001",
      "rel": "optional",
      "dst": "esco:skill:00000000-0000-4000-8000-000000000004",
      "meta": null
    },
    {
      "src": "esco:occupation:00000000-0000-4000-8000-000000000001",
      "rel": "optional",
      "dst": "esco:skill:00000000-0000-4000-8000-000000000005",
      "meta": null
    },
    {
      "src": "esco:occupation:00000000-0000-4000-8000-000000000002",
      "rel": "essential",
      "dst": "esco:skill:00000000-0000-4000-8000-000000000001",
      "meta": null
    },
    {
      "src": "esco:occupation:00000000-0000-4000-8000-000000000002",
      "rel": "essential",
      "dst": "esco:skill:00000000-0000-4000-8000-000000000002",
      "meta": null
    },
    {
      "src": "esco:occupation:00000000-0000-4000-8000-000000000003",
      "rel": "essential",
      "dst": "esco:skill:00000000-0000-4000-8000-000000000001",
      "meta": null
    },
    {
      "src": "esco:occupation:00000000-0000-4000-8000-000000000003",
      "rel": "optional",
      "dst": "esco:skill:00000000-0000-4000-8000-000000000007",
      "meta": null
    },
    {
      "src": "esco:skill:00000000-0000-4000-8000-000000000001",
      "rel": "broader",
      "dst": "esco:skill:S1.1",
      "meta": null
    },
    {
      "src": "esco:skill:00000000-0000-4000-8000-000000000003",
      "rel": "broader",
      "dst": "esco:isced-f:061",
      "meta": null
    },
    {
      "src": "esco:skill:00000000-0000-4000-8000-000000000004",
      "rel": "broader",
      "dst": "esco:isced-f:061",
      "meta": null
    },
    {
      "src": "esco:skill:00000000-0000-4000-8000-000000000005",
      "rel": "skill-optional",
      "dst": "esco:skill:00000000-0000-4000-8000-000000000008",
      "meta": null
    },
    {
      "src": "esco:skill:S1.1",
      "rel": "broader",
      "dst": "esco:skill:S1",
      "meta": null
    },
    {
      "src": "onet:activity:4.A.3.b.1.I01",
      "rel": "broader",
      "dst": "onet:activity:4.A.3.b.1",
      "meta": null
    },
    {
      "src": "onet:activity:4.A.3.b.1.I01.D01",
      "rel": "broader",
      "dst": "onet:activity:4.A.3.b.1.I01",
      "meta": null
    },
    {
      "src": "onet:activity:4.A.3.b.1.I01.D02",
      "rel": "broader",
      "dst": "onet:activity:4.A.3.b.1.I01",
      "meta": null
    },
    {
      "src": "onet:activity:4.A.4.b.4.I01",
      "rel": "broader",
      "dst": "onet:activity:4.A.4.b.4",
      "meta": null
    },
    {
      "src": "onet:activity:4.A.4.b.4.I01.D01",
      "rel": "broader",
      "dst": "onet:activity:4.A.4.b.4.I01",
      "meta": null
    },
    {
      "src": "onet:activity:4.A.4.c.3.I01",
      "rel": "broader",
      "dst": "onet:activity:4.A.4.c.3",
      "meta": null
    },
    {
      "src": "onet:activity:4.A.4.c.3.I01.D01",
      "rel": "broader",
      "dst": "onet:activity:4.A.4.c.3.I01",
      "meta": null
    },
    {
      "src": "onet:occ:99-1001.00",
      "rel": "matches",
      "dst": "esco:isco:C2512",
      "meta": {
        "type": "narrow"
      }
    },
    {
      "src": "onet:occ:99-1001.00",
      "rel": "matches",
      "dst": "esco:occupation:00000000-0000-4000-8000-000000000001",
      "meta": {
        "type": "exact"
      }
    },
    {
      "src": "onet:occ:99-1001.00",
      "rel": "performs",
      "dst": "onet:activity:4.A.3.b.1.I01.D01",
      "meta": {
        "tasks": 2
      }
    },
    {
      "src": "onet:occ:99-1001.00",
      "rel": "performs",
      "dst": "onet:activity:4.A.3.b.1.I01.D02",
      "meta": {
        "tasks": 1
      }
    },
    {
      "src": "onet:occ:99-1001.00",
      "rel": "uses",
      "dst": "onet:tool:amazon-web-services-aws-software",
      "meta": {
        "hot": true,
        "inDemand": true
      }
    },
    {
      "src": "onet:occ:99-1001.00",
      "rel": "uses",
      "dst": "onet:tool:c++",
      "meta": null
    },
    {
      "src": "onet:occ:99-1001.00",
      "rel": "uses",
      "dst": "onet:tool:go",
      "meta": null
    },
    {
      "src": "onet:occ:99-1001.00",
      "rel": "uses",
      "dst": "onet:tool:kubernetes",
      "meta": {
        "hot": true
      }
    },
    {
      "src": "onet:occ:99-1001.00",
      "rel": "uses",
      "dst": "onet:tool:python",
      "meta": {
        "hot": true,
        "inDemand": true
      }
    },
    {
      "src": "onet:occ:99-1002.00",
      "rel": "matches",
      "dst": "esco:occupation:00000000-0000-4000-8000-000000000002",
      "meta": {
        "type": "close"
      }
    },
    {
      "src": "onet:occ:99-1002.00",
      "rel": "performs",
      "dst": "onet:activity:4.A.4.b.4.I01.D01",
      "meta": {
        "tasks": 1
      }
    },
    {
      "src": "onet:occ:99-1002.00",
      "rel": "performs",
      "dst": "onet:activity:4.A.4.c.3.I01.D01",
      "meta": {
        "tasks": 1
      }
    },
    {
      "src": "onet:occ:99-1002.00",
      "rel": "uses",
      "dst": "onet:tool:microsoft-excel",
      "meta": null
    },
    {
      "src": "onet:occ:99-1002.00",
      "rel": "uses",
      "dst": "onet:tool:python",
      "meta": {
        "hot": true
      }
    },
    {
      "src": "onet:occ:99-1003.00",
      "rel": "matches",
      "dst": "esco:occupation:00000000-0000-4000-8000-000000000003",
      "meta": {
        "type": "broad"
      }
    },
    {
      "src": "onet:occ:99-1003.00",
      "rel": "performs",
      "dst": "onet:activity:4.A.4.c.3.I01.D01",
      "meta": {
        "tasks": 1
      }
    },
    {
      "src": "onet:occ:99-1003.00",
      "rel": "uses",
      "dst": "onet:tool:microsoft-excel",
      "meta": {
        "hot": true,
        "inDemand": true
      }
    },
    {
      "src": "onet:task:9001",
      "rel": "task-activity",
      "dst": "onet:activity:4.A.3.b.1.I01.D01",
      "meta": null
    },
    {
      "src": "onet:task:9001",
      "rel": "task-of",
      "dst": "onet:occ:99-1001.00",
      "meta": null
    },
    {
      "src": "onet:task:9002",
      "rel": "task-activity",
      "dst": "onet:activity:4.A.3.b.1.I01.D01",
      "meta": null
    },
    {
      "src": "onet:task:9002",
      "rel": "task-activity",
      "dst": "onet:activity:4.A.3.b.1.I01.D02",
      "meta": null
    },
    {
      "src": "onet:task:9002",
      "rel": "task-of",
      "dst": "onet:occ:99-1001.00",
      "meta": null
    },
    {
      "src": "onet:task:9003",
      "rel": "task-activity",
      "dst": "onet:activity:4.A.4.b.4.I01.D01",
      "meta": null
    },
    {
      "src": "onet:task:9003",
      "rel": "task-of",
      "dst": "onet:occ:99-1002.00",
      "meta": null
    },
    {
      "src": "onet:task:9004",
      "rel": "task-activity",
      "dst": "onet:activity:4.A.4.c.3.I01.D01",
      "meta": null
    },
    {
      "src": "onet:task:9004",
      "rel": "task-of",
      "dst": "onet:occ:99-1003.00",
      "meta": null
    },
    {
      "src": "onet:task:9005",
      "rel": "task-activity",
      "dst": "onet:activity:4.A.4.c.3.I01.D01",
      "meta": null
    },
    {
      "src": "onet:task:9005",
      "rel": "task-of",
      "dst": "onet:occ:99-1002.00",
      "meta": null
    },
    {
      "src": "onet:tool:amazon-web-services-aws-software",
      "rel": "broader",
      "dst": "onet:toolcat:5.A.1.02",
      "meta": null
    },
    {
      "src": "onet:tool:c++",
      "rel": "broader",
      "dst": "onet:toolcat:5.A.1.01",
      "meta": null
    },
    {
      "src": "onet:tool:go",
      "rel": "broader",
      "dst": "onet:toolcat:5.A.1.01",
      "meta": null
    },
    {
      "src": "onet:tool:go",
      "rel": "same-label",
      "dst": "esco:skill:00000000-0000-4000-8000-000000000006",
      "meta": null
    },
    {
      "src": "onet:tool:kubernetes",
      "rel": "broader",
      "dst": "onet:toolcat:5.A.1.02",
      "meta": null
    },
    {
      "src": "onet:tool:kubernetes",
      "rel": "same-label",
      "dst": "esco:skill:00000000-0000-4000-8000-000000000004",
      "meta": null
    },
    {
      "src": "onet:tool:microsoft-excel",
      "rel": "broader",
      "dst": "onet:toolcat:5.A.2.01",
      "meta": null
    },
    {
      "src": "onet:tool:python",
      "rel": "broader",
      "dst": "onet:toolcat:5.A.1.01",
      "meta": null
    },
    {
      "src": "onet:tool:python",
      "rel": "same-label",
      "dst": "esco:skill:00000000-0000-4000-8000-000000000003",
      "meta": null
    }
  ]
};

/** The SQL that loads the same records into D1, one statement per entry. */
export const TAXONOMY_FIXTURE_SQL: readonly string[] = [
  "CREATE TABLE taxonomy_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;",
  "CREATE TABLE concepts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, scheme TEXT NOT NULL, code TEXT, label TEXT NOT NULL, description TEXT, meta TEXT NOT NULL DEFAULT '{}') WITHOUT ROWID;",
  "CREATE INDEX concepts_by_code ON concepts (scheme, code) WHERE code IS NOT NULL;",
  "CREATE TABLE labels (norm TEXT NOT NULL, concept_id TEXT NOT NULL, kind TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (norm, concept_id)) WITHOUT ROWID;",
  "CREATE INDEX labels_by_concept ON labels (concept_id);",
  "CREATE TABLE relations (src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, meta TEXT, PRIMARY KEY (src, rel, dst)) WITHOUT ROWID;",
  "CREATE INDEX relations_by_dst ON relations (dst, rel);",
  "INSERT INTO concepts (id, kind, scheme, code, label, description, meta) VALUES ('esco:isced-f:061', 'skill-group', 'esco', '061', 'information and communication technologies', NULL, '{}'), ('esco:isco:C251', 'occupation-group', 'esco', '251', 'Software and applications developers and analysts', NULL, '{}'), ('esco:isco:C2512', 'occupation-group', 'esco', '2512', 'Software developers', NULL, '{}'), ('esco:occupation:00000000-0000-4000-8000-000000000001', 'occupation', 'esco', '2512.4', 'software developer', 'Software developers implement or program software systems.', '{\"iscoGroup\":\"2512\"}'), ('esco:occupation:00000000-0000-4000-8000-000000000002', 'occupation', 'esco', '1330.1', 'ICT project manager', 'ICT project managers schedule, control and direct resources.', '{\"iscoGroup\":\"1330\"}'), ('esco:occupation:00000000-0000-4000-8000-000000000003', 'occupation', 'esco', '2411.1.3', 'budget analyst', 'Budget analysts monitor the spending of institutions.', '{\"iscoGroup\":\"2411\"}'), ('esco:skill:00000000-0000-4000-8000-000000000001', 'skill', 'esco', NULL, 'manage budgets', 'Plan, monitor and report on the budget. Synthetic test row.', '{\"reuse\":\"cross-sector\"}'), ('esco:skill:00000000-0000-4000-8000-000000000002', 'skill', 'esco', NULL, 'lead a team', 'Lead, supervise and motivate a group of people.', '{\"collections\":[\"transversal\"],\"reuse\":\"transversal\"}'), ('esco:skill:00000000-0000-4000-8000-000000000003', 'knowledge', 'esco', NULL, 'Python (computer programming)', 'The techniques and principles of software development in Python.', '{\"collections\":[\"digital\"],\"reuse\":\"sector-specific\"}'), ('esco:skill:00000000-0000-4000-8000-000000000004', 'knowledge', 'esco', NULL, 'container orchestration', 'Tools that deploy, scale and run containers. It''s a synthetic row, with a comma.', '{\"collections\":[\"digital\"],\"reuse\":\"sector-specific\"}'), ('esco:skill:00000000-0000-4000-8000-000000000005', 'skill', 'esco', NULL, 'migrate existing data', 'Apply migration and conversion methods for existing data.', '{\"reuse\":\"cross-sector\"}'), ('esco:skill:00000000-0000-4000-8000-000000000006', 'knowledge', 'esco', NULL, 'Go (computer programming)', 'The techniques and principles of software development in Go.', '{\"reuse\":\"sector-specific\"}'), ('esco:skill:00000000-0000-4000-8000-000000000007', 'skill', 'esco', NULL, 'use spreadsheets software', 'Use software tools to create and edit tabular data.', '{\"reuse\":\"cross-sector\"}'), ('esco:skill:00000000-0000-4000-8000-000000000008', 'knowledge', 'esco', NULL, 'SQL', 'The query language \"SQL\".', '{\"collections\":[\"digital\"],\"reuse\":\"cross-sector\"}'), ('esco:skill:S1', 'skill-group', 'esco', 'S1', 'management skills', NULL, '{}'), ('esco:skill:S1.1', 'skill-group', 'esco', 'S1.1', 'allocating and controlling resources', NULL, '{}'), ('onet:activity:4.A.3.b.1', 'activity', 'onet', '4.A.3.b.1', 'Working with Computers', NULL, '{\"level\":\"general\"}'), ('onet:activity:4.A.3.b.1.I01', 'activity', 'onet', '4.A.3.b.1.I01', 'Program computer systems or production equipment.', NULL, '{\"level\":\"intermediate\"}'), ('onet:activity:4.A.3.b.1.I01.D01', 'activity', 'onet', '4.A.3.b.1.I01.D01', 'Write computer programming code.', NULL, '{\"level\":\"detailed\"}'), ('onet:activity:4.A.3.b.1.I01.D02', 'activity', 'onet', '4.A.3.b.1.I01.D02', 'Migrate software systems to new platforms.', NULL, '{\"level\":\"detailed\"}'), ('onet:activity:4.A.4.b.4', 'activity', 'onet', '4.A.4.b.4', 'Guiding, Directing, and Motivating Subordinates', NULL, '{\"level\":\"general\"}'), ('onet:activity:4.A.4.b.4.I01', 'activity', 'onet', '4.A.4.b.4.I01', 'Direct organizational operations, projects, or services.', NULL, '{\"level\":\"intermediate\"}'), ('onet:activity:4.A.4.b.4.I01.D01', 'activity', 'onet', '4.A.4.b.4.I01.D01', 'Manage project teams.', NULL, '{\"level\":\"detailed\"}'), ('onet:activity:4.A.4.c.3', 'activity', 'onet', '4.A.4.c.3', 'Monitoring and Controlling Resources', NULL, '{\"level\":\"general\"}'), ('onet:activity:4.A.4.c.3.I01', 'activity', 'onet', '4.A.4.c.3.I01', 'Manage budgets or finances.', NULL, '{\"level\":\"intermediate\"}'), ('onet:activity:4.A.4.c.3.I01.D01', 'activity', 'onet', '4.A.4.c.3.I01.D01', 'Prepare operational budgets.', NULL, '{\"level\":\"detailed\"}'), ('onet:occ:99-1001.00', 'occupation', 'onet', '99-1001.00', 'Example Software Developers', 'Research, design, and develop computer software. Synthetic test row.', '{}'), ('onet:occ:99-1002.00', 'occupation', 'onet', '99-1002.00', 'Example Project Management Specialists', 'Analyze and coordinate the schedule, timeline and budget of a project. Synthetic test row.', '{}'), ('onet:occ:99-1003.00', 'occupation', 'onet', '99-1003.00', 'Example Budget Analysts', 'Examine budget estimates for completeness and accuracy. Synthetic test row.', '{}'), ('onet:task:9001', 'task', 'onet', '9001', 'Write and test code for new software features.', NULL, '{\"taskType\":\"Core\"}'), ('onet:task:9002', 'task', 'onet', '9002', 'Move services from one hosting platform to another.', NULL, '{\"taskType\":\"Supplemental\"}'), ('onet:task:9003', 'task', 'onet', '9003', 'Lead project teams and coordinate their work.', NULL, '{\"taskType\":\"Core\"}'), ('onet:task:9004', 'task', 'onet', '9004', 'Prepare and monitor departmental budgets.', NULL, '{\"taskType\":\"Core\"}'), ('onet:task:9005', 'task', 'onet', '9005', 'Track project spending against the approved budget.', NULL, '{}'), ('onet:tool:amazon-web-services-aws-software', 'tool', 'onet', NULL, 'Amazon Web Services AWS software', NULL, '{\"hot\":true}'), ('onet:tool:c++', 'tool', 'onet', NULL, 'C++', NULL, '{}'), ('onet:tool:go', 'tool', 'onet', NULL, 'Go', NULL, '{}'), ('onet:tool:kubernetes', 'tool', 'onet', NULL, 'Kubernetes', NULL, '{\"hot\":true}'), ('onet:tool:microsoft-excel', 'tool', 'onet', NULL, 'Microsoft Excel', NULL, '{\"hot\":true}'), ('onet:tool:python', 'tool', 'onet', NULL, 'Python', NULL, '{\"hot\":true}'), ('onet:toolcat:5.A.1.01', 'tool-category', 'onet', '5.A.1.01', 'Object or component oriented development software', NULL, '{}'), ('onet:toolcat:5.A.1.02', 'tool-category', 'onet', '5.A.1.02', 'Container orchestration software', NULL, '{}'), ('onet:toolcat:5.A.2.01', 'tool-category', 'onet', '5.A.2.01', 'Spreadsheet software', NULL, '{}');",
  "INSERT INTO labels (norm, concept_id, kind, type, text) VALUES ('allocating and controlling resources', 'esco:skill:S1.1', 'skill-group', 'preferred', 'allocating and controlling resources'), ('amazon web services aws', 'onet:tool:amazon-web-services-aws-software', 'tool', 'derived', 'Amazon Web Services AWS'), ('amazon web services aws software', 'onet:tool:amazon-web-services-aws-software', 'tool', 'preferred', 'Amazon Web Services AWS software'), ('budget analyst', 'esco:occupation:00000000-0000-4000-8000-000000000003', 'occupation', 'preferred', 'budget analyst'), ('budget management', 'esco:skill:00000000-0000-4000-8000-000000000001', 'skill', 'alternative', 'budget management'), ('c++', 'onet:tool:c++', 'tool', 'preferred', 'C++'), ('container orchestration', 'esco:skill:00000000-0000-4000-8000-000000000004', 'knowledge', 'preferred', 'container orchestration'), ('container orchestration software', 'onet:toolcat:5.A.1.02', 'tool-category', 'preferred', 'Container orchestration software'), ('data migration', 'esco:skill:00000000-0000-4000-8000-000000000005', 'skill', 'alternative', 'data migration'), ('direct organizational operations projects or services', 'onet:activity:4.A.4.b.4.I01', 'activity', 'preferred', 'Direct organizational operations, projects, or services.'), ('example budget analysts', 'onet:occ:99-1003.00', 'occupation', 'preferred', 'Example Budget Analysts'), ('example project management specialists', 'onet:occ:99-1002.00', 'occupation', 'preferred', 'Example Project Management Specialists'), ('example software developers', 'onet:occ:99-1001.00', 'occupation', 'preferred', 'Example Software Developers'), ('go', 'esco:skill:00000000-0000-4000-8000-000000000006', 'knowledge', 'derived', 'Go'), ('go', 'onet:tool:go', 'tool', 'preferred', 'Go'), ('go computer programming', 'esco:skill:00000000-0000-4000-8000-000000000006', 'knowledge', 'preferred', 'Go (computer programming)'), ('golang', 'esco:skill:00000000-0000-4000-8000-000000000006', 'knowledge', 'alternative', 'Golang'), ('guiding directing and motivating subordinates', 'onet:activity:4.A.4.b.4', 'activity', 'preferred', 'Guiding, Directing, and Motivating Subordinates'), ('ict project manager', 'esco:occupation:00000000-0000-4000-8000-000000000002', 'occupation', 'preferred', 'ICT project manager'), ('information and communication technologies', 'esco:isced-f:061', 'skill-group', 'preferred', 'information and communication technologies'), ('it project manager', 'esco:occupation:00000000-0000-4000-8000-000000000002', 'occupation', 'alternative', 'IT project manager'), ('k8s', 'esco:skill:00000000-0000-4000-8000-000000000004', 'knowledge', 'alternative', 'K8s'), ('kubernetes', 'esco:skill:00000000-0000-4000-8000-000000000004', 'knowledge', 'alternative', 'Kubernetes'), ('kubernetes', 'onet:tool:kubernetes', 'tool', 'preferred', 'Kubernetes'), ('lead a team', 'esco:skill:00000000-0000-4000-8000-000000000002', 'skill', 'preferred', 'lead a team'), ('lead teams', 'esco:skill:00000000-0000-4000-8000-000000000002', 'skill', 'alternative', 'lead teams'), ('manage a budget', 'esco:skill:00000000-0000-4000-8000-000000000001', 'skill', 'alternative', 'manage a budget'), ('manage budgets', 'esco:skill:00000000-0000-4000-8000-000000000001', 'skill', 'preferred', 'manage budgets'), ('manage budgets or finances', 'onet:activity:4.A.4.c.3.I01', 'activity', 'preferred', 'Manage budgets or finances.'), ('manage project teams', 'onet:activity:4.A.4.b.4.I01.D01', 'activity', 'preferred', 'Manage project teams.'), ('management skills', 'esco:skill:S1', 'skill-group', 'preferred', 'management skills'), ('microsoft excel', 'onet:tool:microsoft-excel', 'tool', 'preferred', 'Microsoft Excel'), ('migrate existing data', 'esco:skill:00000000-0000-4000-8000-000000000005', 'skill', 'preferred', 'migrate existing data'), ('migrate software systems to new platforms', 'onet:activity:4.A.3.b.1.I01.D02', 'activity', 'preferred', 'Migrate software systems to new platforms.'), ('monitoring and controlling resources', 'onet:activity:4.A.4.c.3', 'activity', 'preferred', 'Monitoring and Controlling Resources'), ('object or component oriented development software', 'onet:toolcat:5.A.1.01', 'tool-category', 'preferred', 'Object or component oriented development software'), ('prepare operational budgets', 'onet:activity:4.A.4.c.3.I01.D01', 'activity', 'preferred', 'Prepare operational budgets.'), ('program computer systems or production equipment', 'onet:activity:4.A.3.b.1.I01', 'activity', 'preferred', 'Program computer systems or production equipment.'), ('programmer', 'esco:occupation:00000000-0000-4000-8000-000000000001', 'occupation', 'alternative', 'programmer'), ('python', 'esco:skill:00000000-0000-4000-8000-000000000003', 'knowledge', 'alternative', 'Python'), ('python', 'onet:tool:python', 'tool', 'preferred', 'Python'), ('python computer programming', 'esco:skill:00000000-0000-4000-8000-000000000003', 'knowledge', 'preferred', 'Python (computer programming)'), ('python3', 'esco:skill:00000000-0000-4000-8000-000000000003', 'knowledge', 'hidden', 'python3'), ('senior backend engineer', 'onet:occ:99-1001.00', 'occupation', 'alternative', 'Senior Backend Engineer'), ('software and applications developers and analysts', 'esco:isco:C251', 'occupation-group', 'preferred', 'Software and applications developers and analysts'), ('software developer', 'esco:occupation:00000000-0000-4000-8000-000000000001', 'occupation', 'preferred', 'software developer'), ('software developers', 'esco:isco:C2512', 'occupation-group', 'preferred', 'Software developers'), ('software engineer', 'esco:occupation:00000000-0000-4000-8000-000000000001', 'occupation', 'alternative', 'software engineer'), ('software engineer', 'onet:occ:99-1001.00', 'occupation', 'alternative', 'Software Engineer'), ('spreadsheet software', 'esco:skill:00000000-0000-4000-8000-000000000007', 'skill', 'alternative', 'spreadsheet software'), ('spreadsheet software', 'onet:toolcat:5.A.2.01', 'tool-category', 'preferred', 'Spreadsheet software'), ('sql', 'esco:skill:00000000-0000-4000-8000-000000000008', 'knowledge', 'preferred', 'SQL'), ('team leadership', 'esco:skill:00000000-0000-4000-8000-000000000002', 'skill', 'alternative', 'team leadership'), ('tech pm', 'onet:occ:99-1002.00', 'occupation', 'alternative', 'Tech PM'), ('technical project manager', 'onet:occ:99-1002.00', 'occupation', 'alternative', 'Technical Project Manager'), ('use spreadsheets software', 'esco:skill:00000000-0000-4000-8000-000000000007', 'skill', 'preferred', 'use spreadsheets software'), ('working with computers', 'onet:activity:4.A.3.b.1', 'activity', 'preferred', 'Working with Computers'), ('write computer programming code', 'onet:activity:4.A.3.b.1.I01.D01', 'activity', 'preferred', 'Write computer programming code.');",
  "INSERT INTO relations (src, rel, dst, meta) VALUES ('esco:isco:C2512', 'broader', 'esco:isco:C251', NULL), ('esco:occupation:00000000-0000-4000-8000-000000000001', 'broader', 'esco:isco:C2512', NULL), ('esco:occupation:00000000-0000-4000-8000-000000000001', 'essential', 'esco:skill:00000000-0000-4000-8000-000000000003', NULL), ('esco:occupation:00000000-0000-4000-8000-000000000001', 'optional', 'esco:skill:00000000-0000-4000-8000-000000000004', NULL), ('esco:occupation:00000000-0000-4000-8000-000000000001', 'optional', 'esco:skill:00000000-0000-4000-8000-000000000005', NULL), ('esco:occupation:00000000-0000-4000-8000-000000000002', 'essential', 'esco:skill:00000000-0000-4000-8000-000000000001', NULL), ('esco:occupation:00000000-0000-4000-8000-000000000002', 'essential', 'esco:skill:00000000-0000-4000-8000-000000000002', NULL), ('esco:occupation:00000000-0000-4000-8000-000000000003', 'essential', 'esco:skill:00000000-0000-4000-8000-000000000001', NULL), ('esco:occupation:00000000-0000-4000-8000-000000000003', 'optional', 'esco:skill:00000000-0000-4000-8000-000000000007', NULL), ('esco:skill:00000000-0000-4000-8000-000000000001', 'broader', 'esco:skill:S1.1', NULL), ('esco:skill:00000000-0000-4000-8000-000000000003', 'broader', 'esco:isced-f:061', NULL), ('esco:skill:00000000-0000-4000-8000-000000000004', 'broader', 'esco:isced-f:061', NULL), ('esco:skill:00000000-0000-4000-8000-000000000005', 'skill-optional', 'esco:skill:00000000-0000-4000-8000-000000000008', NULL), ('esco:skill:S1.1', 'broader', 'esco:skill:S1', NULL), ('onet:activity:4.A.3.b.1.I01', 'broader', 'onet:activity:4.A.3.b.1', NULL), ('onet:activity:4.A.3.b.1.I01.D01', 'broader', 'onet:activity:4.A.3.b.1.I01', NULL), ('onet:activity:4.A.3.b.1.I01.D02', 'broader', 'onet:activity:4.A.3.b.1.I01', NULL), ('onet:activity:4.A.4.b.4.I01', 'broader', 'onet:activity:4.A.4.b.4', NULL), ('onet:activity:4.A.4.b.4.I01.D01', 'broader', 'onet:activity:4.A.4.b.4.I01', NULL), ('onet:activity:4.A.4.c.3.I01', 'broader', 'onet:activity:4.A.4.c.3', NULL), ('onet:activity:4.A.4.c.3.I01.D01', 'broader', 'onet:activity:4.A.4.c.3.I01', NULL), ('onet:occ:99-1001.00', 'matches', 'esco:isco:C2512', '{\"type\":\"narrow\"}'), ('onet:occ:99-1001.00', 'matches', 'esco:occupation:00000000-0000-4000-8000-000000000001', '{\"type\":\"exact\"}'), ('onet:occ:99-1001.00', 'performs', 'onet:activity:4.A.3.b.1.I01.D01', '{\"tasks\":2}'), ('onet:occ:99-1001.00', 'performs', 'onet:activity:4.A.3.b.1.I01.D02', '{\"tasks\":1}'), ('onet:occ:99-1001.00', 'uses', 'onet:tool:amazon-web-services-aws-software', '{\"hot\":true,\"inDemand\":true}'), ('onet:occ:99-1001.00', 'uses', 'onet:tool:c++', NULL), ('onet:occ:99-1001.00', 'uses', 'onet:tool:go', NULL), ('onet:occ:99-1001.00', 'uses', 'onet:tool:kubernetes', '{\"hot\":true}'), ('onet:occ:99-1001.00', 'uses', 'onet:tool:python', '{\"hot\":true,\"inDemand\":true}'), ('onet:occ:99-1002.00', 'matches', 'esco:occupation:00000000-0000-4000-8000-000000000002', '{\"type\":\"close\"}'), ('onet:occ:99-1002.00', 'performs', 'onet:activity:4.A.4.b.4.I01.D01', '{\"tasks\":1}'), ('onet:occ:99-1002.00', 'performs', 'onet:activity:4.A.4.c.3.I01.D01', '{\"tasks\":1}'), ('onet:occ:99-1002.00', 'uses', 'onet:tool:microsoft-excel', NULL), ('onet:occ:99-1002.00', 'uses', 'onet:tool:python', '{\"hot\":true}'), ('onet:occ:99-1003.00', 'matches', 'esco:occupation:00000000-0000-4000-8000-000000000003', '{\"type\":\"broad\"}'), ('onet:occ:99-1003.00', 'performs', 'onet:activity:4.A.4.c.3.I01.D01', '{\"tasks\":1}'), ('onet:occ:99-1003.00', 'uses', 'onet:tool:microsoft-excel', '{\"hot\":true,\"inDemand\":true}'), ('onet:task:9001', 'task-activity', 'onet:activity:4.A.3.b.1.I01.D01', NULL), ('onet:task:9001', 'task-of', 'onet:occ:99-1001.00', NULL), ('onet:task:9002', 'task-activity', 'onet:activity:4.A.3.b.1.I01.D01', NULL), ('onet:task:9002', 'task-activity', 'onet:activity:4.A.3.b.1.I01.D02', NULL), ('onet:task:9002', 'task-of', 'onet:occ:99-1001.00', NULL), ('onet:task:9003', 'task-activity', 'onet:activity:4.A.4.b.4.I01.D01', NULL), ('onet:task:9003', 'task-of', 'onet:occ:99-1002.00', NULL), ('onet:task:9004', 'task-activity', 'onet:activity:4.A.4.c.3.I01.D01', NULL), ('onet:task:9004', 'task-of', 'onet:occ:99-1003.00', NULL), ('onet:task:9005', 'task-activity', 'onet:activity:4.A.4.c.3.I01.D01', NULL), ('onet:task:9005', 'task-of', 'onet:occ:99-1002.00', NULL), ('onet:tool:amazon-web-services-aws-software', 'broader', 'onet:toolcat:5.A.1.02', NULL), ('onet:tool:c++', 'broader', 'onet:toolcat:5.A.1.01', NULL), ('onet:tool:go', 'broader', 'onet:toolcat:5.A.1.01', NULL), ('onet:tool:go', 'same-label', 'esco:skill:00000000-0000-4000-8000-000000000006', NULL), ('onet:tool:kubernetes', 'broader', 'onet:toolcat:5.A.1.02', NULL), ('onet:tool:kubernetes', 'same-label', 'esco:skill:00000000-0000-4000-8000-000000000004', NULL), ('onet:tool:microsoft-excel', 'broader', 'onet:toolcat:5.A.2.01', NULL), ('onet:tool:python', 'broader', 'onet:toolcat:5.A.1.01', NULL), ('onet:tool:python', 'same-label', 'esco:skill:00000000-0000-4000-8000-000000000003', NULL);",
  "INSERT INTO taxonomy_meta (key, value) VALUES ('format', '1'), ('version', 'esco-0.0.1+onet-0.0+3191aa55'), ('contentHash', '3191aa557f27852e085394f81e9d7677841fc9f0f1bbffd696fb8f256edc21ce'), ('sources', '[{\"id\":\"esco\",\"name\":\"ESCO classification\",\"version\":\"0.0.1\"},{\"id\":\"onet\",\"name\":\"O*NET 0.0 Database\",\"version\":\"0.0\"},{\"id\":\"esco-onet-crosswalk\",\"name\":\"O*NET - ESCO crosswalk (occupations)\",\"version\":\"test\"}]'), ('records', CASE WHEN (SELECT COUNT(*) FROM concepts) = 43 AND (SELECT COUNT(*) FROM labels) = 58 AND (SELECT COUNT(*) FROM relations) = 58 THEN '{\"concepts\":43,\"labels\":58,\"relations\":58}' END);"
];
