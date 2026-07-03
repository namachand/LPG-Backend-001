import axios from "axios";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5001/api";

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
});

export const AUTH_TOKEN_KEY = "token";
export const AUTH_USER_KEY = "user";

// Attach the stored bearer token (if any) to every request.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// --- Auth ---------------------------------------------------------------
export const identifyAuthMethod = async (identifier) => {
  const response = await api.post("/auth/identify", { identifier });
  return response.data;
};

export const loginWithPassword = async (identifier, password) => {
  const response = await api.post("/auth/login/password", { identifier, password });
  return response.data;
};

export const requestOtp = async (identifier) => {
  const response = await api.post("/auth/login/otp/request", { identifier });
  return response.data;
};

export const verifyOtp = async (identifier, otp) => {
  const response = await api.post("/auth/login/otp/verify", { identifier, otp });
  return response.data;
};

export const fetchCustomers = async (search = "") => {
  const response = await api.get("/customer-complaints/customers", {
    params: {
      search: search || undefined,
      limit: 4,
    },
  });

  return response.data?.data || [];
};

export const fetchComplaints = async (search = "") => {
  const response = await api.get("/customer-complaints/complaints", {
    params: {
      search: search || undefined,
      page: 1,
      limit: 50,
    },
  });

  return response.data?.data || [];
};

export const createComplaint = async (payload) => {
  const response = await api.post("/customer-complaints/complaints", payload);
  return response.data;
};

export const fetchComplaintDrivers = async () => {
  const response = await api.get("/godown/drivers");
  return response.data?.data || [];
};

export const assignComplaintToDeliveryBoy = async (complaintId, driverId) => {
  const response = await api.patch(`/customer-complaints/complaints/${complaintId}/assign-delivery`, { driverId });
  return response.data;
};

export const updateComplaintStatus = async (complaintId, status) => {
  const response = await api.patch(`/customer-complaints/complaints/${complaintId}/status`, { status });
  return response.data;
};

export const fetchRecentConnections = async () => {
  const response = await api.get("/customer-connections/recent");
  return response.data?.data || [];
};

export const createNewConnection = async (payload) => {
  const response = await api.post("/customer-connections", payload);
  return response.data;
};

export const searchConnectionProducts = async (search = "") => {
  const response = await api.get("/customer-connections/products/search", {
    params: { search: search || undefined },
  });
  return response.data?.data || [];
};

export const lookupTransferCustomer = async ({ consumerNumber, existingName }) => {
  const response = await api.get("/customer-transfers/lookup", {
    params: {
      consumerNumber: consumerNumber || undefined,
      existingName: existingName || undefined,
    },
  });

  return response.data?.data || null;
};

export const fetchRecentTransfers = async () => {
  const response = await api.get("/customer-transfers/recent");
  return response.data?.data || [];
};

export const createCustomerTransfer = async (payload) => {
  const response = await api.post("/customer-transfers", payload);
  return response.data;
};

export const lookupNameChangeCustomer = async ({ consumerNumber, existingName }) => {
  const response = await api.get("/name-changes/lookup", {
    params: {
      consumerNumber: consumerNumber || undefined,
      existingName: existingName || undefined,
    },
  });

  return response.data?.data || null;
};

export const fetchRecentNameChanges = async () => {
  const response = await api.get("/name-changes/recent");
  return response.data?.data || [];
};

export const createNameChangeRequest = async (payload) => {
  const response = await api.post("/name-changes", payload);
  return response.data;
};

export const lookupPenaltyCustomer = async ({ consumerNumber, customerName }) => {
  const response = await api.get("/pr-penalties/lookup", {
    params: {
      consumerNumber: consumerNumber || undefined,
      customerName: customerName || undefined,
    },
  });

  return response.data?.data || null;
};

export const fetchRecentPenalties = async () => {
  const response = await api.get("/pr-penalties/recent");
  return response.data?.data || [];
};

export const createPenalty = async (payload) => {
  const response = await api.post("/pr-penalties", payload);
  return response.data;
};

export const markPenaltyPaid = async (penaltyId) => {
  const response = await api.patch(`/pr-penalties/${penaltyId}/mark-paid`);
  return response.data;
};

export const fetchIocOtpSummary = async () => {
  const response = await api.get("/ioc-otps/summary");
  return response.data?.data || { todayReceived: 0, todayPending: 0, todaySent: 0, allPending: 0 };
};

export const fetchIocOtps = async ({ status, date, driverId } = {}) => {
  const response = await api.get("/ioc-otps", {
    params: {
      status: status || undefined,
      date: date || undefined,
      driverId: driverId || undefined,
    },
  });
  return response.data?.data || [];
};

export const markOtpSent = async (otpId) => {
  const response = await api.patch(`/ioc-otps/${otpId}/mark-sent`);
  return response.data;
};

export const addIocOtpManual = async (payload) => {
  const response = await api.post("/ioc-otps", payload);
  return response.data;
};

export const fetchCustomerDirectory = async (search = "") => {
  const response = await api.get("/customer-dashboard/customers", {
    params: {
      search: search || undefined,
    },
  });

  return response.data?.data || [];
};

export const fetchCustomerDashboardDetails = async (customerId) => {
  const response = await api.get(`/customer-dashboard/customers/${customerId}`);
  return response.data?.data || null;
};

export const fetchDashboardOverview = async () => {
  const response = await api.get("/dashboard/overview");
  return (
    response.data?.data || {
      cards: {
        pendingComplaints: 0,
        leakageComplaints: 0,
        newConnections: 0,
        transferRequests: 0,
        nameChangeRequests: 0,
        pendingManagerVerification: 0,
      },
      recentComplaints: [],
    }
  );
};

export const uploadSupportingDocument = async (file) => {
  const formData = new FormData();
  formData.append("file", file);

  const response = await api.post("/upload/supporting-document", formData, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });

  return response.data?.url || null;
};

export const updateNameChangeApprovalStatus = async (nameChangeId, approvalStatus) => {
  const response = await api.patch(`/name-changes/${nameChangeId}/approval`, { approvalStatus });
  return response.data;
};

export const updateTransferApprovalStatus = async (transferId, approvalStatus) => {
  const response = await api.patch(`/customer-transfers/${transferId}/approval`, { approvalStatus });
  return response.data;
};
