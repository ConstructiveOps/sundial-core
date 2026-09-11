// fields.js — the Sundial_Estimate__c / _Job__c names and the SELECT list shared by
// the estimate Lambda and the public (customer page) Lambda, so the two can never
// read different columns for the same record.

export const ESTIMATE_SF_OBJECT = "Sundial_Estimate__c";
export const JOB_SF_OBJECT = "Sundial_Service_Job__c";

export const ESTIMATE_SELECT =
  "Id, Name, Sundial_Customer__c, Service_Job__c, Client__c, Status__c, Version__c, Version_Log__c, " +
  "Is_Template__c, Template_Name__c, Customer_Name_at_Creation__c, Address_at_Creation__c, " +
  "Primary_Phone_at_Creation__c, Primary_Email_at_Creation__c, Originating_Solar_Project__c, " +
  "Originating_Roofing_Project__c, Originating_Commercial_Project__c, Sold_By__c, " +
  "Discount_Scope__c, Discount_Type__c, Discount_Value__c, Discount_Amount__c, Discount_Source__c, " +
  "Markup_Type__c, Markup_Value__c, Markup_Amount__c, Tax_Rate__c, Tax_Jurisdiction__c, Tax_Amount__c, " +
  "Labor_Subtotal__c, Material_Subtotal__c, Fee_Subtotal__c, Subtotal__c, Total__c, " +
  "Deposit_Required__c, Deposit_Type__c, Deposit_Value__c, Deposit_Amount__c, Deposit_Paid_At__c, " +
  "Approved_At__c, Approved_Version__c, Approved_Amount__c, Approval_Method__c, Approved_By_Name__c, " +
  "Declined_Reason__c, Valid_Until__c, Last_Sent_At__c, Last_Sent_Via__c, Public_Token__c, " +
  "Public_Token_Expires_At__c, Scope_Summary__c, Created_In_Field__c, Created_By_Service_Call__c";
