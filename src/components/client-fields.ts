import type { FieldSpec } from "./record-form";
import { RECORDED_EVENTS } from "@/lib/payors/evaluate";

/** Client detail fields, shared by the new-client and edit forms. */
export const clientFields: FieldSpec[] = [
  { name: "firstName", label: "First name" },
  { name: "lastName", label: "Last name" },
  { name: "preferredName", label: "Preferred name", optional: true },
  { name: "dob", label: "Date of birth", type: "date" },
  { name: "sex", label: "Sex", optional: true },
  { name: "serviceAddress.line1", label: "Service address" },
  { name: "serviceAddress.city", label: "City" },
  { name: "serviceAddress.state", label: "State", placeholder: "GA" },
  { name: "serviceAddress.zip", label: "ZIP" },
  { name: "hasIep", label: "Has an IEP or IFSP", type: "checkbox" },
  { name: "events", label: "Payor events that have occurred", type: "checkboxes", options: RECORDED_EVENTS },
  {
    name: "guardians",
    label: "Guardians",
    type: "list",
    addLabel: "Add guardian",
    fields: [
      { name: "name", label: "Name" },
      { name: "relationship", label: "Relationship", placeholder: "mother" },
      { name: "legalCustody", label: "Legal custody", type: "checkbox" },
      { name: "canSign", label: "May sign", type: "checkbox" },
    ],
  },
];
