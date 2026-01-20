---
description: "Create a detailed implementation plan in the form of a feature story."
---

# Plan a new task

## Feature: $ARGUMENTS

## Goal

Given a feature request, generate a detailed implementation plan. Do not write code. That is the resposibility of the implementer. You can generate steps in plain language or psudo-code where appropriate. The goal is to create a plan that is detailed enough to enable ai agents to implement the plan without difficulty. 

If no specific feature is given as an argument, look for the next uncompleted task in todo.md in the root of the project. 

The details should include more than just an outline of business logic. Include design patterns, coding best practices, documentation and validations. The ai agent that executes this should be given plenty of context. 

Use the file engineering-design.md in the root of the project to understand high level design goals. You may also use any files in the .claude/resouces directory. 

If unsure about anything, ask the user for clarification. 

If during research, any best practices or anti-patterns to avoid are found add them to best-practices.md.

When done, save the plan in a .agents/plan directory within the target service's directory as a markdown file. Use a filename convention like <featurname>-plan.md

The first section of the document should be a title like "# Implementation Plan: POST /inventory/products - Create Product"

The second section should be a status with a status of "PENDING." For example:

```
# Status: Pending
```

## Report

After creating the Plan, provide:

- Summary of feature and approach
- Full path to created Plan file
- Complexity assessment
- Key implementation risks or considerations
- Estimated confidence score for one-pass success