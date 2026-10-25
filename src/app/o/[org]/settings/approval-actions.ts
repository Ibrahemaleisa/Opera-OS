"use server";

import { orgAction } from "@/server/action";
import { exceptionInput, policyInput, setApprovalException, setApprovalPolicy, setApprovalSla, slaInput } from "@/server/modules/approvals/settings";

/** Approval policy settings (BUSINESS_RULES §4): policy and exception are owner-only; the SLA needs org.manage. */
export const setApprovalPolicyAction = orgAction(policyInput, setApprovalPolicy);
export const setApprovalSlaAction = orgAction(slaInput, setApprovalSla);
export const setApprovalExceptionAction = orgAction(exceptionInput, setApprovalException);
