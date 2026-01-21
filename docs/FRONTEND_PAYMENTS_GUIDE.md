# Frontend Payment Integration Guide (Razorpay)

## Overview

This guide explains how to integrate the Backend Payment APIs in the Frontend React application.

## 1. Installation

Add the Razorpay SDK to your `index.html` (Recommended for reliability) or install via npm.

```html
<!-- public/index.html -->
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
```

## 2. Integration Flow

The integration involves three main steps:

1.  **Create Order**: Call Backend to get `order_id`.
2.  **Open Checkout**: Initialize Razorpay with the options.
3.  **Verify Payment**: Send the success response to Backend.

## 3. React Implementation (Hook)

Create a custom hook `usePayment.ts` to handle the logic.

```typescript
// hooks/usePayment.ts
import { useState } from "react";
import axios from "axios";

interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

export const usePayment = () => {
  const [loading, setLoading] = useState(false);

  const handlePayment = async (bookingId: string) => {
    setLoading(true);
    try {
      // 1. Create Order
      const { data: order } = await axios.post("/api/payments/create-order", {
        bookingId,
      });

      const options = {
        key: order.key, // Backend returns the Key ID
        amount: order.amount * 100, // Amount in paise
        currency: order.currency,
        name: "CareConnect",
        description: "Nanny Service Payment",
        order_id: order.orderId,
        handler: async (response: RazorpayResponse) => {
          // 3. Verify Payment
          try {
            await axios.post("/api/payments/verify", response);
            alert("Payment Successful! Booking Confirmed.");
            // TODO: Redirect to Booking Success Page
          } catch (verifyError) {
            alert("Payment Verification Failed");
          }
        },
        prefill: {
          name: "Parent Name", // Fetch from Context
          email: "parent@example.com",
          contact: "9999999999",
        },
        theme: {
          color: "#3399cc",
        },
      };

      const rzp = new (window as any).Razorpay(options);
      rzp.on("payment.failed", function (response: any) {
        alert(response.error.description);
      });
      rzp.open();
    } catch (error) {
      console.error("Payment initialization failed", error);
      alert("Could not start payment.");
    } finally {
      setLoading(false);
    }
  };

  return { handlePayment, loading };
};
```

## 4. Using the Hook in Components

```tsx
import { usePayment } from "../hooks/usePayment";

export const BookingSummary = ({ bookingId }) => {
  const { handlePayment, loading } = usePayment();

  return (
    <div className="p-4 border rounded shadow">
      <h2 className="text-xl font-bold">Booking Total: ₹500</h2>
      <button
        onClick={() => handlePayment(bookingId)}
        disabled={loading}
        className="mt-4 bg-blue-600 text-white px-4 py-2 rounded"
      >
        {loading ? "Processing..." : "Pay Now"}
      </button>
    </div>
  );
};
```

## 5. Error Handling

### Common Issues

1.  **"Order ID not found"**: Ensure `create-order` endpoint is returning a valid ID starting with `order_`.
2.  **Signature Mismatch**: This usually happens if the backend secret key is wrong. Check `.env`.
3.  **Browser Popup Blocked**: Razorpay opens in a modal, but ensure no aggressive popup blockers are active.
