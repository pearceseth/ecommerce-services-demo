---
description: "Review the local changes against the given plan document."
---

# Review the local code changes against the given plan document and best practices document.

## Feature: $ARGUMENTS

## Goal

The goal is to ensure the quality of the staged changes. 

## Steps

* Review the given implementation plan and best practices contained within .claude/resources/best-practices.md.
* Review the local code changes on the current git branch based on the implementation plan and best practices. 
* The code changes must capture the goals of the plan and must abide by best practices.
* Ensure that test coverage is at least 80%. 
* If there are issues found, build a report to output to the user. 
* If no issues are found, report all clear to the user.
* Once you are done, edit the plan document and change the Status near the top of the document from PENDING to COMPLETE.