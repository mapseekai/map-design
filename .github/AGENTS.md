# GitHub automation

Workflows validate MapDesign source, packages, and end-to-end behavior. Read the workflow and its helper scripts before changing automation.

Keep privileged workflow actions behind explicit, data-only handoffs. Do not execute pull-request code in a privileged workflow. Run the checks required by the changed workflow when practical.