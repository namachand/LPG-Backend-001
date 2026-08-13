-- =============================================================================
-- Multi-Agency / Multi-Tenant Database Migration
-- This script adds an `agencies` table and scopes all existing data to a 
-- default agency (ID: 1, Name: 'Suraj Gas Agency') to prevent data loss.
-- =============================================================================

SET FOREIGN_KEY_CHECKS=0;

-- 1. Create the new agencies table
CREATE TABLE IF NOT EXISTS `agencies` (
  `id` int NOT NULL AUTO_INCREMENT,
  `agency_name` varchar(150) NOT NULL,
  `gst_number` varchar(50) NOT NULL,
  `phone_number` varchar(15) NOT NULL,
  `email_id` varchar(100) NOT NULL,
  `address` text NOT NULL,
  `state` varchar(100) NOT NULL,
  `district` varchar(100) NOT NULL,
  `pin_code` varchar(10) NOT NULL,
  `subscription_plan` varchar(100) DEFAULT NULL,
  `terms_accepted` tinyint(1) NOT NULL DEFAULT 1,
  `status` enum('ACTIVE','INACTIVE') DEFAULT 'ACTIVE',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2. Insert the Default Agency (Suraj Gas Agency)
INSERT INTO `agencies` (
  `id`, `agency_name`, `gst_number`, `phone_number`, `email_id`, 
  `address`, `state`, `district`, `pin_code`, `subscription_plan`, `terms_accepted`, `status`
) VALUES (
  1, 'Suraj Gas Agency', 'PENDING_GST', '0000000000', 'admin@surajgas.com', 
  'Default Address', 'Default State', 'Default District', '000000', 'Default Plan', 1, 'ACTIVE'
) ON DUPLICATE KEY UPDATE `agency_name` = 'Suraj Gas Agency';


-- 3. Modify Users Table
ALTER TABLE `users`
  MODIFY COLUMN `role` enum('SUPER_ADMIN','OWNER','DRIVER','CASHIER','GODOWN_MANAGER','PURCHASE_MANAGER','SUPPORT','CUSTOMER') DEFAULT NULL,
  ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;

ALTER TABLE `users`
  ADD CONSTRAINT `fk_users_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);


-- 4. Add agency_id to all operational and transactional tables

-- stock_areas
ALTER TABLE `stock_areas` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `stock_areas` ADD CONSTRAINT `fk_stock_areas_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- drivers
ALTER TABLE `drivers` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `drivers` ADD CONSTRAINT `fk_drivers_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- expenses
ALTER TABLE `expenses` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `expenses` ADD CONSTRAINT `fk_expenses_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- office_expenses (from AlterDDL)
ALTER TABLE `office_expenses` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `office_expenses` ADD CONSTRAINT `fk_office_expenses_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- other_payments (from AlterDDL)
ALTER TABLE `other_payments` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `other_payments` ADD CONSTRAINT `fk_other_payments_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- purchase_trips
ALTER TABLE `purchase_trips` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `purchase_trips` ADD CONSTRAINT `fk_purchase_trips_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- purchase_loads
ALTER TABLE `purchase_loads` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `purchase_loads` ADD CONSTRAINT `fk_purchase_loads_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- purchase_load_items
ALTER TABLE `purchase_load_items` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `purchase_load_items` ADD CONSTRAINT `fk_purchase_load_items_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- reports
ALTER TABLE `reports` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `reports` ADD CONSTRAINT `fk_reports_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- issues
ALTER TABLE `issues` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `issues` ADD CONSTRAINT `fk_issues_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- cash_collections
ALTER TABLE `cash_collections` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `cash_collections` ADD CONSTRAINT `fk_cash_collections_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- settlements
ALTER TABLE `settlements` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `settlements` ADD CONSTRAINT `fk_settlements_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- stock (We must drop the existing unique constraint and recreate it including agency_id)
ALTER TABLE `stock` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `stock` DROP INDEX `uq_stock_product_area`;
ALTER TABLE `stock` ADD UNIQUE KEY `uq_stock_product_area_agency` (`product_id`,`stock_area_id`,`agency_id`);
ALTER TABLE `stock` ADD CONSTRAINT `fk_stock_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- stock_transactions
ALTER TABLE `stock_transactions` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `stock_transactions` ADD CONSTRAINT `fk_stock_transactions_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- sales
ALTER TABLE `sales` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `sales` ADD CONSTRAINT `fk_sales_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- sales_items
ALTER TABLE `sales_items` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `sales_items` ADD CONSTRAINT `fk_sales_items_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- payments
ALTER TABLE `payments` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `payments` ADD CONSTRAINT `fk_payments_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- settlement_history
ALTER TABLE `settlement_history` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `settlement_history` ADD CONSTRAINT `fk_settlement_history_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- cashier_closings
ALTER TABLE `cashier_closings` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `cashier_closings` ADD CONSTRAINT `fk_cashier_closings_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- cashier_openings (from AlterDDL)
ALTER TABLE `cashier_openings` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `cashier_openings` ADD CONSTRAINT `fk_cashier_openings_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- cashier_receipts (from AlterDDL)
ALTER TABLE `cashier_receipts` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `cashier_receipts` ADD CONSTRAINT `fk_cashier_receipts_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- customer_complaints (from AlterDDL)
ALTER TABLE `customer_complaints` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `customer_complaints` ADD CONSTRAINT `fk_customer_complaints_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- customer_new_connections (from AlterDDL)
ALTER TABLE `customer_new_connections` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `customer_new_connections` ADD CONSTRAINT `fk_customer_new_connections_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- customer_connection_transfers (from AlterDDL)
ALTER TABLE `customer_connection_transfers` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `customer_connection_transfers` ADD CONSTRAINT `fk_customer_connection_transfers_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- customer_transfer_agencies (from AlterDDL)
ALTER TABLE `customer_transfer_agencies` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `customer_transfer_agencies` ADD CONSTRAINT `fk_customer_transfer_agencies_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- customer_name_change_requests (from AlterDDL)
ALTER TABLE `customer_name_change_requests` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `customer_name_change_requests` ADD CONSTRAINT `fk_customer_name_change_requests_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- customer_pr_penalties (from AlterDDL)
ALTER TABLE `customer_pr_penalties` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `customer_pr_penalties` ADD CONSTRAINT `fk_customer_pr_penalties_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

-- driver_sale_otps (from AlterDDL)
ALTER TABLE `driver_sale_otps` ADD COLUMN `agency_id` int NOT NULL DEFAULT 1 AFTER `id`;
ALTER TABLE `driver_sale_otps` ADD CONSTRAINT `fk_driver_sale_otps_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`);

SET FOREIGN_KEY_CHECKS=1;
