---
description: "Implement code changes specified in a given plan document."
---

# Implement the code changes within a plan document

## Feature: $ARGUMENTS

## Goal

1. Read and understand the file being passed as an argument. This is a description of the change that needs to be made including testing and validation details. Only proceed if the status near the top of the document is PENDING. If it says COMPLETE warn the user and then stop. 
2. You can also analyze the files in .claude/resources/ for some help with best practices and where to find documentation for the dependencies in the project. Always follow the guidance in ./claude/resources/best-practices.md. 
3. Ask the user if anything is unclear. You may also search the web for help if needed. 
4. Once you have a good idea of what needs to be done please implement the changes. Each change should start with unit tests. Always use Test Driven Development. You will create tests that break until the implementation is correct. The goal is that each change has at least 80% test coverage in order to be accepted. There should be some details about this in the plan document. 
5. When completed, launch a sub-agent to review the changes based on the best-practices.md file. 
6. Once you are done, edit the plan document and change the Status near the top of the document from PENDING to COMPLETE.
7. Output to the user a summary of the changes and the test coverage once completed. Also include example curl commands for testing the change if applicable. 