import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

/**
 * GET /api/shifts
 * Returns shifts for a branch
 * Query params:
 * - branchId: Required - Filter by branch
 * - cashierId: Optional - Filter by cashier
 * - status: 'open' | 'closed' | 'all'
 * - startDate: Optional - Filter from this date
 * - endDate: Optional - Filter to this date
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const branchId = searchParams.get('branchId');
    const cashierId = searchParams.get('cashierId');
    const status = searchParams.get('status') || 'all';
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    if (!branchId) {
      return NextResponse.json(
        { error: 'Branch ID is required' },
        { status: 400 }
      );
    }

    // Build where clause
    let whereClause: any = { branchId };

    if (cashierId) {
      whereClause.cashierId = cashierId;
    }

    if (status === 'open') {
      whereClause.isClosed = false;
    } else if (status === 'closed') {
      whereClause.isClosed = true;
    }

    if (startDate || endDate) {
      whereClause.startTime = {};
      if (startDate) {
        whereClause.startTime.gte = new Date(startDate);
      }
      if (endDate) {
        whereClause.startTime.lte = new Date(endDate);
      }
    }

    const shifts = await db.shift.findMany({
      where: whereClause,
      include: {
        cashier: {
          select: {
            id: true,
            username: true,
            name: true,
          },
        },
        _count: {
          select: { orders: true },
        },
      },
      orderBy: {
        startTime: 'desc',
      },
    });

    // Calculate current revenue for open shifts
    const shiftsWithRevenue = await Promise.all(
      shifts.map(async (shift) => {
        // For closed shifts, use stored closingRevenue
        if (shift.isClosed) {
          return {
            ...shift,
            orderCount: shift._count.orders,
            _count: undefined,
          };
        }

        // For open shifts, calculate current revenue from orders
        // Revenue = subtotal (excludes delivery fees which go to couriers)
        const currentOrders = await db.order.aggregate({
          where: {
            shiftId: shift.id,
          },
          _sum: {
            subtotal: true,
          },
          _count: true,
        });

        // Get payment method breakdown
        const paymentStats = await db.order.groupBy({
          by: ['paymentMethod'],
          where: { shiftId: shift.id },
          _sum: { totalAmount: true },
          _count: true,
        });

        const paymentBreakdown = {
          cash: 0,
          card: 0,
          other: 0,
        };

        // Payment breakdown also excludes delivery fees
        const orderPaymentStats = await db.order.groupBy({
          by: ['paymentMethod'],
          where: { shiftId: shift.id },
          _sum: { subtotal: true },
          _count: true,
        });

        orderPaymentStats.forEach(stat => {
          const method = stat.paymentMethod.toLowerCase();
          if (method === 'cash') {
            paymentBreakdown.cash = stat._sum.subtotal || 0;
          } else if (method === 'card') {
            paymentBreakdown.card = stat._sum.subtotal || 0;
          } else {
            paymentBreakdown.other = (paymentBreakdown.other || 0) + (stat._sum.subtotal || 0);
          }
        });

        return {
          ...shift,
          orderCount: currentOrders._count,
          currentRevenue: currentOrders._sum.subtotal || 0,
          currentOrders: currentOrders._count,
          paymentBreakdown,
          _count: undefined,
        };
      })
    );

    return NextResponse.json({
      success: true,
      shifts: shiftsWithRevenue,
    });
  } catch (error) {
    console.error('Error fetching shifts:', error);
    return NextResponse.json(
      { error: 'Failed to fetch shifts' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/shifts
 * Create a new shift
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { branchId, cashierId, openingCash, notes } = body;

    if (!branchId || !cashierId) {
      return NextResponse.json(
        { error: 'Branch ID and Cashier ID are required' },
        { status: 400 }
      );
    }

    // Check if there's an open shift for this cashier
    const existingOpenShift = await db.shift.findFirst({
      where: {
        cashierId,
        isClosed: false,
      },
    });

    if (existingOpenShift) {
      return NextResponse.json(
        { error: 'Cashier already has an open shift' },
        { status: 400 }
      );
    }

    // Get opening orders and revenue
    // Revenue = subtotal (excludes delivery fees which go to couriers)
    const openingData = await db.order.aggregate({
      where: {
        cashierId,
        branchId,
      },
      _count: true,
      _sum: {
        subtotal: true,
      },
    });

    const shift = await db.shift.create({
      data: {
        branchId,
        cashierId,
        openingCash: openingCash || 0,
        openingOrders: openingData._count || 0,
        openingRevenue: openingData._sum.subtotal || 0,
        notes,
      },
      include: {
        cashier: {
          select: {
            id: true,
            username: true,
            name: true,
          },
        },
      },
    });

    return NextResponse.json({
      success: true,
      shift,
    }, { status: 201 });

  } catch (error) {
    console.error('Error creating shift:', error);
    return NextResponse.json(
      { error: 'Failed to create shift' },
      { status: 500 }
    );
  }
}
