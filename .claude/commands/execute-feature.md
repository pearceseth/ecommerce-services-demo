---
description: "Implement code changes specified in a given plan document."
---

# Implement the code changes within a plan document

## Feature: $ARGUMENTS

## Goal

1. Read the file engineering-design.md in the root of the project to understand the system. 
2. Read and understand the file being passed as an argument. This is a description of the change that needs to be made including testing and validation details. Only proceed if the status near the top of the document is PENDING. If it says COMPLETE warn the user and then stop. 
3. You can also analyze the files in .claude/resources/ for some help with best practices and where to find documentation for the dependencies in the project. Always follow the guidance in ./claude/resources/best-practices.md. 
4. Ask the user is anything is unclear. You may also search the web for help if needed. 
5. Once you have a good idea of what needs to be done please implement the changes. Each change should include unit tests. The goal is that each change has at least 80% test coverage in order to be accepted. There should be some details about this in the plan document. 
6. When completed, launch a sub-agent to review the changes based on the best-practices.md file. 
7. Once you are done, edit the plan document and change the Status near the top of the document from PENDING to COMPLETE.
8. Output to the user a summary of the changes and the test coverage once completed. 