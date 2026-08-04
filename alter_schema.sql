-- Schema Alteration to Support Legacy Single-Tenant Inserts
-- This script adds a DEFAULT constraint to all agency_id columns so that 
-- raw SQL queries lacking an agency_id will automatically pick up the RLS context.

ALTER TABLE users ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE user_job_profiles ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE categories ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE stock_areas ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE drivers ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE addresses ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE expenses ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE purchase_trips ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE purchase_loads ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE products ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE customers ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE purchase_load_items ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE reports ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE issues ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE cash_collections ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE settlements ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE stock ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE stock_transactions ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE sales ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE sales_items ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE payments ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE settlement_history ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE cashier_closings ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
ALTER TABLE auth_otp_logs ALTER COLUMN agency_id SET DEFAULT get_current_agency_id();
