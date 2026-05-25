import { StatusCodes } from "http-status-codes";
import handleErrorResponse from "./commonFunction";

interface PaginationResult<T> {
  status: number;
  message: string;
  total: number;
  from: number;
  to: number;
  totalPages: number;
  currentPage: number;
  data: T[];
}

function pagination<T>(
  totalCount: number,
  data: T[],
  limit: number,
  page: number,
  res: any
): PaginationResult<T> | any {
  try {
    const currentPage = page + 1; // convert to 1-based
    const totalPages = Math.ceil(totalCount / limit);

    const from = totalCount === 0 ? 0 : page * limit + 1;
    const to =
      totalCount === 0
        ? 0
        : Math.min(page * limit + data.length, totalCount);

    return res.status(StatusCodes.OK).send({
      status: StatusCodes.OK,
      message: "Pagination successful",
      total: totalCount,
      from,
      to,
      totalPages,
      currentPage,
      data
    });
  } catch (error) {
    return handleErrorResponse(error, res);
  }
}

export default pagination;
